import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { advanceStageSchema, canMoveStage, checkInSchema, handoverSchema, operationSettingsSchema, paymentSchema, stageCorrectionSchema, stages, type MessageEvent, type Stage } from '@carwash/shared';
import { Prisma } from './generated/prisma/client.js';
import type { Db } from './db.js';
import { audit } from './audit.js';
import { currentUser, requireOwner } from './auth.js';
import { resolveServicePrice } from './catalog.js';
import { badRequest, forbidden, HttpError, notFound } from './errors.js';
import { dispatchMessage, messageRecipient, renderCustomerMessage, type MessagingProvider } from './messaging.js';
import { createTrackingToken, readTrackingToken, trackingUrl } from './tracking.js';
import type { Config } from './config.js';

const idParams = z.object({ id: z.string().min(1) });
const listQuery = z.object({
  view: z.enum(['active', 'history']).default('active'),
  q: z.string().trim().max(120).default(''),
  branchId: z.string().optional(),
  serviceId: z.string().optional(),
  date: z.iso.date().optional(),
  vehicleId: z.string().optional(),
});
type User = Awaited<ReturnType<typeof currentUser>>;

function jobScope(user: User): Prisma.JobWhereInput {
  return { organizationId: user.organizationId, ...(user.role === 'EMPLOYEE' && user.branchId ? { branchId: user.branchId } : {}) };
}

async function getJob(db: Db, user: User, id: string) {
  const job = await db.job.findFirst({
    where: { id, ...jobScope(user) },
    include: {
      branch: { select: { id: true, name: true } },
      customer: { select: { id: true, name: true, mobile: true } },
      vehicle: { select: { id: true, registrationNumber: true, make: true, model: true, type: true } },
      checkedInBy: { select: { id: true, name: true } },
      handedOverBy: { select: { id: true, name: true } },
      stages: { include: { actor: { select: { id: true, name: true } } }, orderBy: { createdAt: 'asc' } },
      assignments: { include: { employee: { select: { id: true, name: true } } }, orderBy: { assignedAt: 'asc' } },
      messages: { include: { deliveryAttempts: { orderBy: { number: 'asc' } } }, orderBy: { createdAt: 'asc' } },
      invoice: { include: { payments: { include: { collectedBy: { select: { id: true, name: true } } }, orderBy: { createdAt: 'asc' } } } },
      inspection: { include: { recordedBy: { select: { id: true, name: true } }, damages: true } },
      photos: { select: { id: true, kind: true, description: true, customerVisible: true, damageItemId: true, createdAt: true, uploadedBy: { select: { id: true, name: true } } }, orderBy: { createdAt: 'asc' } },
    },
  });
  if (!job) notFound();
  if (user.role === 'EMPLOYEE') {
    return {
      id: job.id,
      number: job.number,
      status: job.status,
      serviceName: job.serviceName,
      checkedInAt: job.checkedInAt,
      stageAt: job.stageAt,
      expectedAt: job.expectedAt,
      handedOverAt: job.handedOverAt,
      notes: job.notes,
      branch: job.branch,
      customer: job.customer,
      vehicle: job.vehicle,
      checkedInBy: job.checkedInBy,
      handedOverBy: job.handedOverBy,
      stages: job.stages.map((stage) => ({ id: stage.id, fromStage: stage.fromStage, toStage: stage.toStage, note: stage.note, createdAt: stage.createdAt, actor: stage.actor })),
      assignments: job.assignments.map((assignment) => ({ id: assignment.id, removedAt: assignment.removedAt, employee: assignment.employee })),
      inspection: job.inspection ? {
        id: job.inspection.id,
        finalizedAt: job.inspection.finalizedAt,
        recordedBy: job.inspection.recordedBy,
        damages: job.inspection.damages.map((damage) => ({ id: damage.id, location: damage.location, type: damage.type, description: damage.description })),
      } : null,
      photos: job.photos,
      messages: job.messages.map((message) => ({ id: message.id, event: message.event, status: message.status, createdAt: message.createdAt, sentAt: message.sentAt, failedAt: message.failedAt })),
    };
  }
  const paidPaise = job.invoice?.payments.reduce((sum, payment) => sum + payment.amountPaise, 0) ?? 0;
  const { trackingTokenHash: _hash, trackingTokenCiphertext: _ciphertext, ...publicJob } = job;
  return { ...publicJob, paidPaise, outstandingPaise: Math.max(0, job.totalPaise - paidPaise), paymentStatus: paidPaise === 0 ? 'UNPAID' : paidPaise < job.totalPaise ? 'PARTIALLY_PAID' : 'PAID' };
}

async function queueMessage(tx: Prisma.TransactionClient, job: { id: string; organizationId: string; branchId: string; customerId: string; trackingTokenHash: string | null; trackingTokenCiphertext: string | null }, event: MessageEvent, customer: { name: string; mobile: string }, vehicleNumber: string, businessName: string, config: Config) {
  const settings = await tx.organizationWhatsAppConfig.findUnique({ where: { organizationId: job.organizationId } });
  if (settings?.enabled === false) return null;
  const templateKey = { VEHICLE_RECEIVED: settings?.templateReceived ?? 'VEHICLE_RECEIVED', WASH_STARTED: settings?.templateWashing ?? 'WASH_STARTED', VEHICLE_READY: settings?.templateReady ?? 'VEHICLE_READY', VEHICLE_HANDED_OVER: settings ? settings.templateHandedOver : 'VEHICLE_HANDED_OVER' }[event];
  if (!templateKey) return null;
  const organization = await tx.organization.findUniqueOrThrow({ where: { id: job.organizationId }, select: { showCustomerTrackingLink: true } });
  let tokenHash = job.trackingTokenHash;
  let ciphertext = job.trackingTokenCiphertext;
  if (!tokenHash || !ciphertext) {
    const generated = createTrackingToken(config.trackingSecret);
    tokenHash = generated.hash;
    ciphertext = generated.ciphertext;
    await tx.job.update({ where: { id: job.id }, data: { trackingTokenHash: tokenHash, trackingTokenCiphertext: ciphertext } });
  }
  const url = organization.showCustomerTrackingLink ? trackingUrl(config.APP_ORIGIN, readTrackingToken(config.trackingSecret, ciphertext)) : undefined;
  const message = await tx.message.upsert({
    where: { jobId_event: { jobId: job.id, event } },
    update: {},
    create: { organizationId: job.organizationId, branchId: job.branchId, jobId: job.id, customerId: job.customerId, event, templateKey, recipient: messageRecipient(customer.mobile), renderedText: renderCustomerMessage(event, customer.name, vehicleNumber, businessName, url), provider: settings?.provider ?? 'MOCK', senderNumber: settings?.senderNumber ?? null, senderDisplayName: settings?.senderDisplayName ?? null, trackingTokenHash: tokenHash },
  });
  return message.status === 'PENDING' && message.attempts === 0 ? message.id : null;
}

export function registerOperationsRoutes(app: FastifyInstance, db: Db, messaging: MessagingProvider, config: Config) {
  const dispatch = (id: string | null) => {
    if (id) setImmediate(() => { void dispatchMessage(db, messaging, id).catch((error: unknown) => app.log.error({ err: error, messageId: id }, 'Message dispatch failed')); });
  };

  const worker = setInterval(() => {
    void db.message.updateMany({ where: { status: 'SENDING', updatedAt: { lt: new Date(Date.now() - 5 * 60_000) } }, data: { status: 'PENDING' } })
      .then(() => db.message.findMany({ where: { status: 'PENDING' }, select: { id: true }, take: 20, orderBy: { createdAt: 'asc' } }))
      .then((messages) => messages.forEach((message) => dispatch(message.id)))
      .catch((error: unknown) => app.log.error({ err: error }, 'Message outbox scan failed'));
  }, 30_000);
  worker.unref();
  app.addHook('onClose', async () => clearInterval(worker));

  app.get('/api/operations/capabilities', async (request) => {
    const user = await currentUser(db, request);
    const org = await db.organization.findUniqueOrThrow({ where: { id: user.organizationId }, select: { allowOutstanding: true, employeeHandover: true } });
    if (user.role === 'EMPLOYEE') return { canHandover: org.employeeHandover && org.allowOutstanding };
    return { allowOutstanding: org.allowOutstanding, canHandover: true };
  });

  app.get('/api/operations/available-employees', async (request) => {
    const user = await requireOwner(db, request);
    const { branchId } = z.object({ branchId: z.string().optional() }).parse(request.query);
    return db.user.findMany({ where: { organizationId: user.organizationId, role: 'EMPLOYEE', active: true, ...(branchId ? { OR: [{ branchId }, { branchId: null }] } : {}) }, select: { id: true, name: true, branchId: true }, orderBy: { name: 'asc' } });
  });

  app.get('/api/operations/settings', async (request) => {
    const owner = await requireOwner(db, request);
    return db.organization.findUniqueOrThrow({ where: { id: owner.organizationId }, select: { allowOutstanding: true, employeeHandover: true, sendHandoverMessage: true, showCustomerTrackingLink: true, showCompletedVehiclePhotos: true } });
  });

  app.patch('/api/operations/settings', async (request) => {
    const owner = await requireOwner(db, request);
    const input = operationSettingsSchema.parse(request.body);
    const before = await db.organization.findUniqueOrThrow({ where: { id: owner.organizationId }, select: { allowOutstanding: true, employeeHandover: true, sendHandoverMessage: true, showCustomerTrackingLink: true, showCompletedVehiclePhotos: true } });
    return db.$transaction(async (tx) => {
      const updated = await tx.organization.update({ where: { id: owner.organizationId }, data: input, select: { allowOutstanding: true, employeeHandover: true, sendHandoverMessage: true, showCustomerTrackingLink: true, showCompletedVehiclePhotos: true } });
      await audit(tx, { organizationId: owner.organizationId, actorUserId: owner.id, action: 'OPERATIONS_SETTINGS_UPDATED', entityType: 'Organization', entityId: owner.organizationId, before, after: updated, ipAddress: request.ip });
      return updated;
    });
  });

  app.get('/api/jobs', async (request) => {
    const user = await currentUser(db, request);
    const input = listQuery.parse(request.query);
    if (input.branchId && user.role === 'EMPLOYEE' && user.branchId && input.branchId !== user.branchId) forbidden();
    const plate = input.q.toUpperCase().replace(/[^A-Z0-9]/g, '');
    const digits = input.q.replace(/\D/g, '');
    const start = input.date ? new Date(`${input.date}T00:00:00+05:30`) : null;
    const end = start ? new Date(start.getTime() + 86_400_000) : null;
    const where: Prisma.JobWhereInput = {
      ...jobScope(user),
      status: input.view === 'active' ? { not: 'HANDED_OVER' } : 'HANDED_OVER',
      ...(input.branchId ? { branchId: input.branchId } : {}),
      ...(input.serviceId ? { serviceId: input.serviceId } : {}),
      ...(input.vehicleId ? { vehicleId: input.vehicleId } : {}),
      ...(start && end ? { checkedInAt: { gte: start, lt: end } } : {}),
      ...(input.q ? { OR: [
        { customer: { name: { contains: input.q, mode: 'insensitive' } } },
        ...(digits.length >= 3 ? [{ customer: { mobile: { contains: digits } } }] : []),
        ...(plate.length >= 2 ? [{ vehicle: { registrationNumber: { contains: plate } } }] : []),
        { serviceName: { contains: input.q, mode: 'insensitive' } },
      ] } : {}),
    };
    const jobs = await db.job.findMany({ where, include: { branch: { select: { id: true, name: true } }, customer: { select: { id: true, name: true, mobile: true } }, vehicle: { select: { id: true, registrationNumber: true, make: true, model: true } } }, orderBy: { checkedInAt: 'desc' }, take: 150 });
    if (user.role === 'OWNER') return jobs.map(({ trackingTokenHash: _hash, trackingTokenCiphertext: _ciphertext, ...job }) => job);
    return jobs.map((job) => ({
      id: job.id,
      number: job.number,
      status: job.status,
      serviceName: job.serviceName,
      checkedInAt: job.checkedInAt,
      stageAt: job.stageAt,
      expectedAt: job.expectedAt,
      handedOverAt: job.handedOverAt,
      branch: job.branch,
      customer: job.customer,
      vehicle: job.vehicle,
    }));
  });

  app.get('/api/board/metrics', async (request) => {
    const user = await currentUser(db, request);
    const { branchId, date } = z.object({ branchId: z.string().optional(), date: z.iso.date().optional() }).parse(request.query);
    if (branchId && user.role === 'EMPLOYEE' && user.branchId && branchId !== user.branchId) forbidden();
    const scope = { ...jobScope(user), ...(branchId ? { branchId } : {}) };
    const [received, washing, ready, late] = await Promise.all([
      db.job.count({ where: { ...scope, status: 'RECEIVED' } }),
      db.job.count({ where: { ...scope, status: 'WASHING' } }),
      db.job.count({ where: { ...scope, status: 'READY' } }),
      db.job.count({ where: { ...scope, status: { not: 'HANDED_OVER' }, expectedAt: { lt: new Date() } } }),
    ]);
    if (user.role === 'EMPLOYEE') return { inBay: received + washing, received, washing, ready, late };
    const day = date ?? new Date(Date.now() + 5.5 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const start = new Date(`${day}T00:00:00+05:30`);
    const payments = await db.payment.aggregate({ where: { organizationId: user.organizationId, createdAt: { gte: start, lt: new Date(start.getTime() + 86_400_000) }, ...(branchId ? { invoice: { job: { branchId } } } : {}) }, _sum: { amountPaise: true } });
    return { inBay: received + washing, received, washing, ready, late, collectedPaise: payments._sum.amountPaise ?? 0 };
  });

  app.post('/api/jobs/check-in', async (request, reply) => {
    const user = await currentUser(db, request);
    const input = checkInSchema.parse(request.body);
    if (user.role === 'EMPLOYEE' && input.employeeIds.length) forbidden();
    const existing = await db.job.findUnique({ where: { organizationId_idempotencyKey: { organizationId: user.organizationId, idempotencyKey: input.idempotencyKey } } });
    if (existing) return getJob(db, user, existing.id);
    const activeBranches = await db.branch.findMany({ where: { organizationId: user.organizationId, active: true }, select: { id: true } });
    const branchId = input.branchId ?? user.branchId ?? (activeBranches.length === 1 ? activeBranches[0]?.id : undefined);
    if (!branchId || !activeBranches.some((branch) => branch.id === branchId)) badRequest('Choose an active branch');
    if (user.role === 'EMPLOYEE' && user.branchId && user.branchId !== branchId) forbidden();
    const expectedAt = new Date(input.expectedAt);
    if (expectedAt <= new Date()) badRequest('Expected completion must be in the future');
    const result = await db.$transaction(async (tx) => {
      const priorCustomer = await tx.customer.findUnique({ where: { organizationId_mobile: { organizationId: user.organizationId, mobile: input.mobile } } });
      const customer = priorCustomer ?? await tx.customer.create({ data: { organizationId: user.organizationId, name: input.customerName, mobile: input.mobile } });
      if (!priorCustomer) await audit(tx, { organizationId: user.organizationId, actorUserId: user.id, action: 'CUSTOMER_CREATED', entityType: 'Customer', entityId: customer.id, after: { name: customer.name, mobile: customer.mobile }, ipAddress: request.ip });
      const priorVehicle = await tx.vehicle.findUnique({ where: { organizationId_registrationNumber: { organizationId: user.organizationId, registrationNumber: input.registrationNumber } } });
      if (priorVehicle && priorVehicle.customerId !== customer.id) throw new HttpError(409, 'VEHICLE_OWNER_CONFLICT', 'Vehicle belongs to another customer. Check the mobile number.');
      const vehicle = priorVehicle ?? await tx.vehicle.create({ data: { organizationId: user.organizationId, customerId: customer.id, registrationNumber: input.registrationNumber, make: input.make, model: input.model, type: input.vehicleType } });
      if (!priorVehicle) await audit(tx, { organizationId: user.organizationId, actorUserId: user.id, action: 'VEHICLE_CREATED', entityType: 'Vehicle', entityId: vehicle.id, after: { registrationNumber: vehicle.registrationNumber, customerId: customer.id }, ipAddress: request.ip });
      const active = await tx.job.findFirst({ where: { organizationId: user.organizationId, vehicleId: vehicle.id, status: { not: 'HANDED_OVER' } } });
      if (active) throw new HttpError(409, 'VEHICLE_ALREADY_ACTIVE', 'This vehicle is already on the board');
      const priced = await resolveServicePrice(tx as Db, user.organizationId, input.serviceId, branchId, vehicle.type);
      const employeeIds = user.role === 'EMPLOYEE' ? [user.id] : [...new Set(input.employeeIds)];
      if (user.role === 'OWNER' && employeeIds.length) {
        const employees = await tx.user.findMany({ where: { id: { in: employeeIds }, organizationId: user.organizationId, role: 'EMPLOYEE', active: true, OR: [{ branchId }, { branchId: null }] }, select: { id: true } });
        if (employees.length !== employeeIds.length) badRequest('Choose active employees from this branch');
      }
      const org = await tx.organization.update({ where: { id: user.organizationId }, data: { nextJobNumber: { increment: 1 } }, select: { nextJobNumber: true, name: true } });
      const taxPaise = Math.round(priced.pricePaise * priced.service.taxRateBps / 10_000);
      const tracking = createTrackingToken(config.trackingSecret);
      const job = await tx.job.create({ data: { organizationId: user.organizationId, branchId, customerId: customer.id, vehicleId: vehicle.id, serviceId: priced.service.id, number: org.nextJobNumber - 1, idempotencyKey: input.idempotencyKey, serviceName: priced.service.name, subtotalPaise: priced.pricePaise, taxPaise, totalPaise: priced.pricePaise + taxPaise, checkedInById: user.id, expectedAt, notes: input.notes, notify: input.notify, trackingTokenHash: tracking.hash, trackingTokenCiphertext: tracking.ciphertext } });
      await tx.jobStageHistory.create({ data: { organizationId: user.organizationId, jobId: job.id, toStage: 'RECEIVED', actorUserId: user.id, note: 'Vehicle checked in' } });
      for (const employeeId of employeeIds) {
        const assignment = await tx.jobAssignment.create({ data: { organizationId: user.organizationId, jobId: job.id, employeeId, assignedById: user.id } });
        await audit(tx, { organizationId: user.organizationId, actorUserId: user.id, action: 'JOB_ASSIGNED', entityType: 'JobAssignment', entityId: assignment.id, after: { jobId: job.id, employeeId }, ipAddress: request.ip });
      }
      await audit(tx, { organizationId: user.organizationId, actorUserId: user.id, action: 'JOB_CHECKED_IN', entityType: 'Job', entityId: job.id, after: { number: job.number, vehicleId: vehicle.id, status: 'RECEIVED', totalPaise: job.totalPaise, branchId }, ipAddress: request.ip });
      const messageId = input.notify ? await queueMessage(tx, job, 'VEHICLE_RECEIVED', customer, vehicle.registrationNumber, org.name, config) : null;
      return { jobId: job.id, messageId };
    });
    dispatch(result.messageId);
    return reply.code(201).send(await getJob(db, user, result.jobId));
  });

  app.get('/api/jobs/:id', async (request) => {
    const user = await currentUser(db, request);
    const { id } = idParams.parse(request.params);
    return getJob(db, user, id);
  });

  app.post('/api/jobs/:id/tracking-link', async (request) => {
    const user = await currentUser(db, request);
    const { id } = idParams.parse(request.params);
    const job = await db.job.findFirst({ where: { id, ...jobScope(user) }, select: { id: true, trackingTokenCiphertext: true, organization: { select: { showCustomerTrackingLink: true } } } });
    if (!job) notFound();
    if (!job.organization.showCustomerTrackingLink) return { enabled: false, url: null };
    let ciphertext = job.trackingTokenCiphertext;
    if (!ciphertext) {
      const tracking = createTrackingToken(config.trackingSecret);
      const updated = await db.$transaction(async (tx) => {
        const result = await tx.job.updateMany({ where: { id, organizationId: user.organizationId, trackingTokenHash: null }, data: { trackingTokenHash: tracking.hash, trackingTokenCiphertext: tracking.ciphertext } });
        if (result.count) await audit(tx, { organizationId: user.organizationId, actorUserId: user.id, action: 'JOB_TRACKING_TOKEN_CREATED', entityType: 'Job', entityId: id, ipAddress: request.ip });
        return result.count;
      });
      ciphertext = updated ? tracking.ciphertext : (await db.job.findUniqueOrThrow({ where: { id }, select: { trackingTokenCiphertext: true } })).trackingTokenCiphertext;
    }
    if (!ciphertext) throw new HttpError(409, 'TRACKING_UNAVAILABLE', 'Tracking link is unavailable');
    return { enabled: true, url: trackingUrl(config.APP_ORIGIN, readTrackingToken(config.trackingSecret, ciphertext)) };
  });

  app.post('/api/jobs/:id/advance', async (request) => {
    const user = await currentUser(db, request);
    const { id } = idParams.parse(request.params);
    const { to } = advanceStageSchema.parse(request.body);
    const current = await db.job.findFirst({ where: { id, ...jobScope(user) }, include: { customer: true, vehicle: true, organization: true } });
    if (!current) notFound();
    if (current.status === to) return getJob(db, user, id);
    if (!canMoveStage(current.status as Stage, to)) throw new HttpError(409, 'INVALID_TRANSITION', 'Move one stage forward at a time');
    const messageId = await db.$transaction(async (tx) => {
      const updated = await tx.job.updateMany({ where: { id, organizationId: user.organizationId, status: current.status }, data: { status: to, stageAt: new Date() } });
      if (!updated.count) throw new HttpError(409, 'STAGE_CHANGED', 'Vehicle status changed. Refresh the board.');
      await tx.jobStageHistory.create({ data: { organizationId: user.organizationId, jobId: id, fromStage: current.status, toStage: to, actorUserId: user.id } });
      await audit(tx, { organizationId: user.organizationId, actorUserId: user.id, action: 'JOB_STAGE_CHANGED', entityType: 'Job', entityId: id, before: { status: current.status }, after: { status: to }, ipAddress: request.ip });
      return current.notify ? queueMessage(tx, current, to === 'WASHING' ? 'WASH_STARTED' : 'VEHICLE_READY', current.customer, current.vehicle.registrationNumber, current.organization.name, config) : null;
    });
    dispatch(messageId);
    return getJob(db, user, id);
  });

  app.post('/api/jobs/:id/correct-stage', async (request) => {
    const owner = await requireOwner(db, request);
    const { id } = idParams.parse(request.params);
    const { to, reason } = stageCorrectionSchema.parse(request.body);
    const job = await db.job.findFirst({ where: { id, organizationId: owner.organizationId } });
    if (!job) notFound();
    const currentIndex = stages.indexOf(job.status);
    if (job.status === 'HANDED_OVER' || stages[currentIndex - 1] !== to) throw new HttpError(409, 'INVALID_CORRECTION', 'Only the previous active stage can be restored');
    await db.$transaction(async (tx) => {
      const updated = await tx.job.updateMany({ where: { id, organizationId: owner.organizationId, status: job.status }, data: { status: to, stageAt: new Date() } });
      if (!updated.count) throw new HttpError(409, 'STAGE_CHANGED', 'Vehicle status changed. Refresh the board.');
      await tx.jobStageHistory.create({ data: { organizationId: owner.organizationId, jobId: id, fromStage: job.status, toStage: to, actorUserId: owner.id, note: `Correction: ${reason}` } });
      await audit(tx, { organizationId: owner.organizationId, actorUserId: owner.id, action: 'JOB_STAGE_CORRECTED', entityType: 'Job', entityId: id, before: { status: job.status }, after: { status: to, reason }, ipAddress: request.ip });
    });
    return getJob(db, owner, id);
  });

  app.post('/api/jobs/:id/handover', async (request) => {
    const user = await currentUser(db, request);
    const { id } = idParams.parse(request.params);
    const input = handoverSchema.parse(request.body);
    const job = await db.job.findFirst({ where: { id, ...jobScope(user) }, include: { customer: true, vehicle: true, organization: true } });
    if (!job) notFound();
    if (job.status === 'HANDED_OVER') return getJob(db, user, id);
    if (job.status !== 'READY') throw new HttpError(409, 'INVALID_TRANSITION', 'Vehicle must be Ready before handover');
    if (user.role === 'EMPLOYEE') {
      if (!job.organization.employeeHandover || !job.organization.allowOutstanding) forbidden();
      if (input.paymentAmountPaise !== 0 || input.paymentMethod || input.paymentReference) forbidden();
    }
    if (input.paymentAmountPaise > job.totalPaise) badRequest('Payment cannot exceed the outstanding amount');
    if (!job.organization.allowOutstanding && input.paymentAmountPaise !== job.totalPaise) badRequest('Full payment is required before handover');
    const messageId = await db.$transaction(async (tx) => {
      const updated = await tx.job.updateMany({ where: { id, organizationId: user.organizationId, status: 'READY' }, data: { status: 'HANDED_OVER', stageAt: new Date(), handedOverAt: new Date(), handedOverById: user.id, handoverNotes: input.notes } });
      if (!updated.count) throw new HttpError(409, 'STAGE_CHANGED', 'Vehicle status changed. Refresh the board.');
      const org = await tx.organization.update({ where: { id: user.organizationId }, data: { nextInvoiceNumber: { increment: 1 } }, select: { nextInvoiceNumber: true, invoicePrefix: true } });
      const invoice = await tx.invoice.create({ data: { organizationId: user.organizationId, jobId: id, invoiceNumber: `${org.invoicePrefix}-${String(org.nextInvoiceNumber - 1).padStart(5, '0')}`, subtotalPaise: job.subtotalPaise, taxPaise: job.taxPaise, totalPaise: job.totalPaise, status: input.paymentAmountPaise === job.totalPaise ? 'PAID' : input.paymentAmountPaise > 0 ? 'PARTIALLY_PAID' : 'ISSUED' } });
      await audit(tx, { organizationId: user.organizationId, actorUserId: user.id, action: 'INVOICE_ISSUED', entityType: 'Invoice', entityId: invoice.id, after: { invoiceNumber: invoice.invoiceNumber, totalPaise: invoice.totalPaise }, ipAddress: request.ip });
      if (input.paymentAmountPaise > 0 && input.paymentMethod) {
        const payment = await tx.payment.create({ data: { organizationId: user.organizationId, invoiceId: invoice.id, idempotencyKey: `handover:${id}`, amountPaise: input.paymentAmountPaise, method: input.paymentMethod, reference: input.paymentReference, collectedById: user.id } });
        await audit(tx, { organizationId: user.organizationId, actorUserId: user.id, action: 'PAYMENT_COLLECTED', entityType: 'Payment', entityId: payment.id, after: { amountPaise: payment.amountPaise, method: payment.method, invoiceId: invoice.id }, ipAddress: request.ip });
      }
      await tx.jobStageHistory.create({ data: { organizationId: user.organizationId, jobId: id, fromStage: 'READY', toStage: 'HANDED_OVER', actorUserId: user.id, note: input.notes } });
      await audit(tx, { organizationId: user.organizationId, actorUserId: user.id, action: 'VEHICLE_HANDED_OVER', entityType: 'Job', entityId: id, before: { status: 'READY' }, after: { status: 'HANDED_OVER', paymentAmountPaise: input.paymentAmountPaise }, ipAddress: request.ip });
      return job.notify && job.organization.sendHandoverMessage ? queueMessage(tx, job, 'VEHICLE_HANDED_OVER', job.customer, job.vehicle.registrationNumber, job.organization.name, config) : null;
    });
    dispatch(messageId);
    return getJob(db, user, id);
  });

  app.post('/api/jobs/:id/payments', async (request, reply) => {
    const owner = await requireOwner(db, request);
    const { id } = idParams.parse(request.params);
    const input = paymentSchema.parse(request.body);
    const job = await db.job.findFirst({ where: { id, organizationId: owner.organizationId }, include: { invoice: true } });
    if (!job?.invoice) notFound();
    const existing = await db.payment.findUnique({ where: { organizationId_idempotencyKey: { organizationId: owner.organizationId, idempotencyKey: input.idempotencyKey } } });
    if (existing) return reply.code(200).send(await getJob(db, owner, id));
    await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Invoice" WHERE "id" = ${job.invoice!.id} FOR UPDATE`;
      const paid = await tx.payment.aggregate({ where: { invoiceId: job.invoice!.id }, _sum: { amountPaise: true } });
      const remaining = job.totalPaise - (paid._sum.amountPaise ?? 0);
      if (input.amountPaise > remaining) badRequest('Payment exceeds the outstanding amount');
      const payment = await tx.payment.create({ data: { organizationId: owner.organizationId, invoiceId: job.invoice!.id, ...input, collectedById: owner.id } });
      await tx.invoice.update({ where: { id: job.invoice!.id }, data: { status: input.amountPaise === remaining ? 'PAID' : 'PARTIALLY_PAID' } });
      await audit(tx, { organizationId: owner.organizationId, actorUserId: owner.id, action: 'PAYMENT_COLLECTED', entityType: 'Payment', entityId: payment.id, after: { amountPaise: payment.amountPaise, method: payment.method, invoiceId: payment.invoiceId }, ipAddress: request.ip });
    });
    return reply.code(201).send(await getJob(db, owner, id));
  });

  app.post('/api/jobs/:id/messages/:messageId/retry', async (request) => {
    const owner = await requireOwner(db, request);
    const { id, messageId } = z.object({ id: z.string(), messageId: z.string() }).parse(request.params);
    const message = await db.message.findFirst({ where: { id: messageId, jobId: id, organizationId: owner.organizationId } });
    if (!message) notFound();
    if (message.status !== 'FAILED') throw new HttpError(409, 'MESSAGE_NOT_FAILED', 'Only failed messages can be retried');
    await db.$transaction(async (tx) => {
      const updated = await tx.message.updateMany({ where: { id: messageId, jobId: id, organizationId: owner.organizationId, status: 'FAILED' }, data: { status: 'PENDING', nextRetryAt: null } });
      if (!updated.count) throw new HttpError(409, 'MESSAGE_NOT_FAILED', 'Only failed messages can be retried');
      await audit(tx, { organizationId: owner.organizationId, actorUserId: owner.id, action: 'MESSAGE_RETRIED', entityType: 'Message', entityId: messageId, before: { status: 'FAILED' }, after: { status: 'PENDING' }, ipAddress: request.ip });
    });
    dispatch(messageId);
    return { status: 'pending' };
  });
}
