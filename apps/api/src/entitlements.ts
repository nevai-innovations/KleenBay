import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Db } from './db.js';
import type { User } from './generated/prisma/client.js';
import { audit } from './audit.js';
import { HttpError, notFound } from './errors.js';

export type EntitlementState = 'NOT_SUBSCRIBED' | 'ACTIVE' | 'GRACE_PERIOD' | 'EXPIRED';
export const DEFAULT_SUBSCRIPTION_GRACE_DAYS = 7;
type Period = { activatedAt: Date | null; currentPeriodStart: Date | null; currentPeriodEnd: Date | null };
const configurations = new WeakMap<FastifyInstance, number>();
const graceCompletionRoutes = new Set([
  '/api/jobs/:id/advance', '/api/jobs/:id/handover', '/api/jobs/:id/payments',
  '/api/jobs/:id/inspection', '/api/jobs/:id/photos', '/api/jobs/:id/invoice',
  '/api/jobs/:id/add-ons', '/api/jobs/:id/messages/:messageId/retry',
  '/api/jobs/:id/tracking-link', '/api/jobs/:id/photos/:photoId/customer-visibility',
  '/api/invoices/:id/issue', '/api/invoices/:id/cancel',
]);
export function configureEntitlements(app: FastifyInstance, graceDays: number) { configurations.set(app, graceDays); }

export function deriveEntitlement(subscription: Period | null, graceDays: number, at = new Date()) {
  const end = subscription?.currentPeriodEnd ?? null;
  const graceEndsAt = end ? new Date(end) : null;
  if (graceEndsAt) graceEndsAt.setUTCDate(graceEndsAt.getUTCDate() + graceDays);
  const state: EntitlementState = !subscription?.activatedAt || !end ? 'NOT_SUBSCRIBED' : at < end ? 'ACTIVE' : at < graceEndsAt! ? 'GRACE_PERIOD' : 'EXPIRED';
  return { state, currentPeriodStart: subscription?.currentPeriodStart ?? null, currentPeriodEnd: end, graceEndsAt,
    daysRemaining: state === 'ACTIVE' ? Math.ceil((end!.getTime() - at.getTime()) / 86400000) : 0,
    graceDaysRemaining: state === 'GRACE_PERIOD' ? Math.ceil((graceEndsAt!.getTime() - at.getTime()) / 86400000) : 0,
    canCreateWork: state === 'ACTIVE', canOperate: state === 'ACTIVE' || state === 'GRACE_PERIOD' };
}
export type Entitlement = ReturnType<typeof deriveEntitlement>;
export function canCompleteExistingJob(entitlement: Entitlement, job: { checkedInAt: Date; status: string }) {
  return entitlement.state === 'ACTIVE' || (entitlement.state === 'GRACE_PERIOD' && job.status !== 'HANDED_OVER' && job.checkedInAt < entitlement.currentPeriodEnd!);
}
export async function getOrganizationEntitlement(db: Db, organizationId: string, graceDays: number, at = new Date()) {
  const subscription = await db.subscription.findUnique({ where: { organizationId } });
  const entitlement = deriveEntitlement(subscription, graceDays, at);
  if (subscription?.activatedAt && subscription.currentPeriodEnd) {
    // Deterministic IDs record each observed period/state once, including across replicas.
    const id = createHash('sha256').update(`${subscription.id}:${subscription.currentPeriodEnd.toISOString()}:${entitlement.state}`).digest('hex');
    await db.auditLog.createMany({ skipDuplicates: true, data: [{ id, organizationId, action: `SUBSCRIPTION_ENTERED_${entitlement.state}`, entityType: 'Subscription', entityId: subscription.id, after: { state: entitlement.state, periodEnd: subscription.currentPeriodEnd.toISOString(), graceEndsAt: entitlement.graceEndsAt!.toISOString(), observedAt: at.toISOString() } }] });
  }
  return entitlement;
}
export async function requireActiveSubscription(db: Db, organizationId: string, graceDays = DEFAULT_SUBSCRIPTION_GRACE_DAYS) {
  const entitlement = await getOrganizationEntitlement(db, organizationId, graceDays);
  if (!entitlement.canCreateWork) throw new HttpError(402, 'SUBSCRIPTION_REQUIRED', 'An active subscription is required');
  return entitlement;
}
export async function requestEntitlement(db: Db, user: User, request: FastifyRequest) {
  return getOrganizationEntitlement(db, user.organizationId, configurations.get(request.server) ?? DEFAULT_SUBSCRIPTION_GRACE_DAYS);
}
export async function enforceEntitlement(db: Db, user: User, request: FastifyRequest) {
  const route = request.routeOptions.url ?? '';
  if (route.startsWith('/api/auth/') || route.startsWith('/api/billing') || route === '/api/entitlement' || route === '/api/operations/capabilities') return;
  const entitlement = await requestEntitlement(db, user, request);
  const read = request.method === 'GET' || request.method === 'HEAD';
  if (entitlement.state === 'ACTIVE' || (read && user.role === 'OWNER')) return;
  let allowed = false;
  if (entitlement.state === 'GRACE_PERIOD') {
    const params = request.params as { id?: string };
    let jobId: string | undefined;
    if (route.startsWith('/api/jobs/:id')) jobId = params.id;
    if (route.startsWith('/api/invoices/:id')) {
      jobId = (await db.invoice.findFirst({ where: { id: params.id, organizationId: user.organizationId }, select: { jobId: true } }))?.jobId;
      if (!jobId) notFound();
    }
    if (route === '/api/photos/:id') {
      jobId = (await db.photo.findFirst({ where: { id: params.id, organizationId: user.organizationId }, select: { jobId: true } }))?.jobId;
      if (!jobId) notFound();
    }
    if (jobId) {
      const job = await db.job.findFirst({ where: { id: jobId, organizationId: user.organizationId, ...(user.role === 'EMPLOYEE' ? { branchId: user.branchId ?? '__unassigned__' } : {}) }, select: { checkedInAt: true, status: true } });
      if (!job) notFound();
      allowed = canCompleteExistingJob(entitlement, job) && (read || graceCompletionRoutes.has(route));
    } else if (read && ['/api/jobs', '/api/board/metrics', '/api/services', '/api/branches', '/api/sale-items'].includes(route)) allowed = true;
  }
  if (allowed) return;
  const code = entitlement.state === 'GRACE_PERIOD' ? 'GRACE_NEW_WORK_BLOCKED' : entitlement.state === 'EXPIRED' ? 'SUBSCRIPTION_EXPIRED' : 'SUBSCRIPTION_REQUIRED';
  if (!read) await audit(db, { organizationId: user.organizationId, actorUserId: user.id, action: 'SUBSCRIPTION_MUTATION_BLOCKED', entityType: 'Organization', entityId: user.organizationId, after: { state: entitlement.state, method: request.method, route }, ipAddress: request.ip });
  throw new HttpError(402, user.role === 'EMPLOYEE' ? 'OPERATIONS_UNAVAILABLE' : code, user.role === 'EMPLOYEE' ? 'Your business subscription is inactive. Please contact the owner.' : entitlement.state === 'GRACE_PERIOD' ? 'Existing vehicles can still be completed, but new work requires renewal.' : 'Renew your KleenBay subscription to continue operations.');
}
