import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { getConfig } from '../src/config.js';
import { createDb } from '../src/db.js';
import { assertLocalTestDatabase } from '../src/database-target.js';
import { createPaidTestOrganization } from './paid-fixture.js';
import { createMessagingProvider, Msg91WhatsAppProvider } from '../src/messaging.js';

const db = createDb(assertLocalTestDatabase(process.env.TEST_DATABASE_URL));
const config = { ...getConfig(), NODE_ENV: 'test' as const, LOG_LEVEL: 'silent', MESSAGING_PROVIDER: 'mock' as const, whatsAppKeys: {} as Record<string, string> };
const sender = '+918137994052';
let orgId: string;
let otherId: string;
let cookie: string;
let employeeCookie: string;
let otherCookie: string;
let app: Awaited<ReturnType<typeof buildApp>>;
const network = vi.fn<typeof fetch>();
async function session(organizationId: string, role: 'OWNER' | 'EMPLOYEE') {
  const user = await db.user.create({ data: { organizationId, role, name: 'Connection QA' } });
  const token = randomUUID();
  await db.session.create({ data: { organizationId, userId: user.id, tokenHash: createHash('sha256').update(token).digest('hex'), expiresAt: new Date(Date.now() + 3_600_000) } });
  return `kleenbay_session=${token}`;
}
function request(method: 'GET' | 'POST' | 'PATCH', url: string, auth = cookie, payload?: unknown) {
  return app.inject({ method, url, headers: { cookie: auth, origin: config.APP_ORIGIN, 'content-type': 'application/json' }, ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }) });
}
beforeAll(async () => {
  orgId = (await createPaidTestOrganization(db, { data: { slug: `wa-${randomUUID()}`, name: 'Connection QA' } })).id;
  otherId = (await createPaidTestOrganization(db, { data: { slug: `wa-${randomUUID()}`, name: 'Other QA' } })).id;
  cookie = await session(orgId, 'OWNER');
  employeeCookie = await session(orgId, 'EMPLOYEE');
  otherCookie = await session(otherId, 'OWNER');
  config.whatsAppKeys[`${orgId}:primary`] = 'private-test-key';
  const router = createMessagingProvider(config);
  const msg91 = new Msg91WhatsAppProvider(config.whatsAppKeys, network);
  app = await buildApp(config, db, undefined, { ...router, forProvider: (name) => name === 'MSG91' ? msg91 : router.forProvider!(name) });
  await db.organizationWhatsAppConfig.create({ data: { organizationId: orgId, provider: 'MSG91', senderNumber: sender, msg91IntegratedNumberId: sender.slice(1), credentialRef: 'primary', senderDisplayName: 'NevAi', templateReceived: 'kb_vehicle_received', templateWashing: 'kb_wash_started', templateReady: 'kb_vehicle_ready', templateHandedOver: null } });
});
afterAll(async () => { await app?.close(); await db.$disconnect(); });

describe('tenant-specific MSG91 connection', () => {
  it('routes explicit MSG91 tenants without changing mock defaults or leaking credentials', async () => {
    const router = createMessagingProvider(config);
    expect(router.forProvider!('MSG91').name).toBe('MSG91');
    expect(router.forProvider!('MOCK').name).toBe('MOCK');
    const response = await request('GET', '/api/whatsapp/settings');
    expect(response.json()).toMatchObject({ provider: 'MSG91', senderNumber: sender, templateHandedOver: null });
    expect(response.body).not.toMatch(/private-test-key|credentialRef|organizationId/);
    expect((await request('GET', '/api/whatsapp/settings', otherCookie)).json()).toMatchObject({ provider: 'MOCK', senderNumber: null });
  });
  it('authenticates sender with GET only and reports review separately without sending', async () => {
    network.mockImplementation(async (url, init) => {
      expect(init?.method).toBe('GET');
      expect(init?.headers).toMatchObject({ authkey: 'private-test-key' });
      if (String(url).includes('whatsapp-activation/')) return Response.json({ data: [{ integrated_number: '918137994052', status: 'active' }] });
      return Response.json({ data: [{ name: new URL(String(url)).searchParams.get('template_name'), language: 'en', status: 'PENDING' }] });
    });
    const before = await db.message.count({ where: { organizationId: orgId } });
    const response = await request('POST', '/api/whatsapp/test-connection', cookie, {});
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: 'CONNECTED', delivered: false, templateStatuses: { kb_vehicle_received: 'IN_REVIEW', kb_wash_started: 'IN_REVIEW', kb_vehicle_ready: 'IN_REVIEW' } });
    expect(network).toHaveBeenCalledTimes(4);
    expect(await db.message.count({ where: { organizationId: orgId } })).toBe(before);
    expect((await db.organizationWhatsAppConfig.findUniqueOrThrow({ where: { organizationId: orgId } })).status).toBe('CONNECTED');
    expect(await db.auditLog.count({ where: { organizationId: orgId, action: 'WHATSAPP_CONNECTION_VERIFIED' } })).toBe(1);
  });
  it('denies employees all settings and connection actions without network calls', async () => {
    network.mockClear();
    for (const [method, path] of [['GET', 'settings'], ['PATCH', 'settings'], ['POST', 'test-connection']] as const) {
      expect((await request(method, `/api/whatsapp/${path}`, employeeCookie, method === 'GET' ? undefined : { enabled: true })).statusCode).toBe(403);
    }
    expect(network).not.toHaveBeenCalled();
  });
  it('does not expose provider error bodies and marks connection failed', async () => {
    network.mockResolvedValue(Response.json({ authkey: 'private-test-key', detail: 'sensitive-provider-payload' }, { status: 401 }));
    const response = await request('POST', '/api/whatsapp/test-connection', cookie, {});
    expect(response.statusCode).toBe(502);
    expect(response.body).not.toMatch(/private-test-key|sensitive-provider-payload/);
    expect((await db.organizationWhatsAppConfig.findUniqueOrThrow({ where: { organizationId: orgId } })).status).toBe('ERROR');
  });
  it('lets owners update templates but invalidates verification; sender provisioning stays isolated', async () => {
    expect((await request('PATCH', '/api/whatsapp/settings', cookie, { templateReady: 'kb_ready_v2', templateHandedOver: null })).statusCode).toBe(200);
    expect((await request('GET', '/api/whatsapp/settings')).json()).toMatchObject({ status: 'NOT_CONNECTED', templateStatuses: {} });
    expect((await request('PATCH', '/api/whatsapp/settings', cookie, { senderNumber: '9876543210' })).statusCode).toBe(409);
    expect((await request('GET', '/api/whatsapp/settings', otherCookie)).json()).toMatchObject({ provider: 'MOCK', templateReady: 'VEHICLE_READY' });
  });
  it('maps dynamic values across the workflow, survives failure, retries once logically, and omits handover', async () => {
    await db.organizationWhatsAppConfig.update({ where: { organizationId: orgId }, data: { status: 'CONNECTED', templateReady: 'kb_vehicle_ready', templateStatuses: { kb_vehicle_received: 'APPROVED', kb_wash_started: 'APPROVED', kb_vehicle_ready: 'APPROVED' } } });
    const branchId = (await db.branch.create({ data: { organizationId: orgId, name: 'Test bay' } })).id;
    const serviceId = (await db.service.create({ data: { organizationId: orgId, name: 'Test wash', category: 'Wash', basePricePaise: 10000, estimatedMinutes: 30 } })).id;
    network.mockRejectedValue(new Error('private-test-key: upstream failure'));
    const input = { idempotencyKey: randomUUID(), mobile: '9876543210', customerName: 'Dynamic Asha', registrationNumber: 'KA01AB4123', make: 'Test', model: 'Test', vehicleType: 'SUV', serviceId, branchId, expectedAt: new Date(Date.now() + 3_600_000).toISOString(), notify: true };
    const created = await request('POST', '/api/jobs/check-in', cookie, input);
    expect(created.statusCode).toBe(201);
    const jobId = created.json().id as string;
    await vi.waitFor(async () => expect(await db.message.count({ where: { jobId, status: 'FAILED' } })).toBe(1));
    expect((await request('POST', `/api/jobs/${jobId}/advance`, cookie, { to: 'WASHING' })).statusCode).toBe(200);
    await vi.waitFor(async () => expect(await db.message.count({ where: { jobId, status: 'FAILED' } })).toBe(2));
    expect((await db.job.findUniqueOrThrow({ where: { id: jobId } })).status).toBe('WASHING');
    const failed = await db.message.findMany({ where: { jobId } });
    expect(failed.every((row) => row.failureReason === 'Provider delivery failed')).toBe(true);
    const bodies: Record<string, unknown>[] = [];
    network.mockImplementation(async (_url, init) => { bodies.push(JSON.parse(String(init?.body))); return Response.json({ request_id: 'accepted-test' }); });
    for (const row of failed) expect((await request('POST', `/api/jobs/${jobId}/messages/${row.id}/retry`, cookie, {})).statusCode).toBe(200);
    await vi.waitFor(async () => expect(await db.message.count({ where: { jobId, status: 'SENT', attempts: 2 } })).toBe(2));
    expect((await request('POST', `/api/jobs/${jobId}/advance`, cookie, { to: 'WASHING' })).statusCode).toBe(200);
    expect((await request('POST', `/api/jobs/${jobId}/advance`, cookie, { to: 'READY' })).statusCode).toBe(200);
    await vi.waitFor(async () => expect(await db.message.count({ where: { jobId, status: 'SENT' } })).toBe(3));
    const messages = await db.message.findMany({ where: { jobId }, orderBy: { createdAt: 'asc' } });
    expect(messages.map((row) => [row.event, row.templateKey])).toEqual([['VEHICLE_RECEIVED', 'kb_vehicle_received'], ['WASH_STARTED', 'kb_wash_started'], ['VEHICLE_READY', 'kb_vehicle_ready']]);
    const variables = messages[0]!.templateVariables;
    expect(variables).toEqual(['Dynamic Asha', 'KA01AB4123', 'Connection QA', expect.stringContaining(`${config.APP_ORIGIN}/track/`)]);
    expect(messages.every((row) => JSON.stringify(row.templateVariables) === JSON.stringify(variables))).toBe(true);
    expect(bodies).toHaveLength(3);
    for (const body of bodies) expect(body).toMatchObject({ integrated_number: '918137994052', payload: { template: { to_and_components: [{ to: ['919876543210'], components: { body_1: { value: 'Dynamic Asha' }, body_2: { value: 'KA01AB4123' }, body_3: { value: 'Connection QA' }, body_4: { value: (variables as string[])[3] } } }] } } });
    expect((await request('POST', '/api/jobs/check-in', cookie, input)).json().id).toBe(jobId);
    expect((await request('POST', `/api/jobs/${jobId}/handover`, cookie, { paymentAmountPaise: 10000, paymentMethod: 'CASH' })).statusCode).toBe(200);
    expect(await db.message.count({ where: { jobId } })).toBe(3);
    expect((await request('GET', `/api/jobs/${jobId}`, otherCookie)).statusCode).toBe(404);
  });
  it('does not send a template whose approval is not verified', async () => {
    const job = await db.job.findFirstOrThrow({ where: { organizationId: orgId } });
    await db.organizationWhatsAppConfig.update({ where: { organizationId: orgId }, data: { templateStatuses: { kb_vehicle_received: 'IN_REVIEW' } } });
    const message = await db.message.findFirstOrThrow({ where: { jobId: job.id, event: 'VEHICLE_RECEIVED' } });
    await db.message.update({ where: { id: message.id }, data: { status: 'PENDING' } });
    network.mockClear();
    const { dispatchMessage } = await import('../src/messaging.js');
    await dispatchMessage(db, { ...createMessagingProvider(config), forProvider: () => new Msg91WhatsAppProvider(config.whatsAppKeys, network) }, message.id);
    expect(network).not.toHaveBeenCalled();
    expect((await db.message.findUniqueOrThrow({ where: { id: message.id } })).status).toBe('FAILED');
  });
  it('fails closed for a foreign sender or tenant credential and tolerates unknown template status', async () => {
    const provider = new Msg91WhatsAppProvider(config.whatsAppKeys, network);
    const input = { organizationId: orgId, credentialRef: 'primary', integratedNumberId: sender.slice(1), senderNumber: sender, templates: ['kb_vehicle_received'] };
    await expect(provider.checkConnection({ ...input, organizationId: otherId })).rejects.toThrow('not configured');
    network.mockResolvedValue(Response.json({ data: [{ integrated_number: '919999999999' }] }));
    await expect(provider.checkConnection(input)).rejects.toThrow('not found');
    network.mockImplementation(async (url) => String(url).includes('whatsapp-activation/') ? Response.json({ data: [{ integrated_number: sender.slice(1) }] }) : Response.json({}, { status: 403 }));
    expect(await provider.checkConnection(input)).toEqual({ templateStatuses: { kb_vehicle_received: 'UNKNOWN' } });
  });
});
