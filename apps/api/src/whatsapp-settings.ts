import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { normalizeIndianMobile } from '@carwash/shared';
import type { Db } from './db.js';
import type { Config } from './config.js';
import { audit } from './audit.js';
import { requireOwner } from './auth.js';
import { HttpError } from './errors.js';
import type { MessagingProvider } from './messaging.js';

const template = z.string().trim().min(1).max(120).regex(/^[A-Za-z0-9_-]+$/);
const patchSchema = z.object({
  enabled: z.boolean().optional(),
  senderNumber: z.union([z.string().trim().max(32), z.null()]).optional().transform((value) => value ? normalizeIndianMobile(value) : value),
  senderDisplayName: z.union([z.string().trim().max(80), z.null()]).optional(),
  templateReceived: template.optional(),
  templateWashing: template.optional(),
  templateReady: template.optional(),
  templateHandedOver: z.union([template, z.null()]).optional(),
}).refine((value) => Object.values(value).some((item) => item !== undefined));

const defaults = {
  provider: 'MOCK' as const,
  enabled: true,
  senderNumber: null,
  senderDisplayName: null,
  msg91IntegratedNumberId: null,
  templateReceived: 'VEHICLE_RECEIVED',
  templateWashing: 'WASH_STARTED',
  templateReady: 'VEHICLE_READY',
  templateHandedOver: 'VEHICLE_HANDED_OVER',
  status: 'MOCK_ACTIVE' as const,
  lastVerifiedAt: null,
  templateStatuses: {},
};

function safeConfig(record: Awaited<ReturnType<Db['organizationWhatsAppConfig']['findUnique']>>, provider: 'mock' | 'msg91' = 'mock') {
  if (!record) return provider === 'msg91' ? { ...defaults, provider: 'MSG91' as const, status: 'NOT_CONNECTED' as const } : defaults;
  const { credentialRef: _secretRef, mockFailNext: _mockFailNext, organizationId: _organizationId, createdAt: _createdAt, updatedAt: _updatedAt, ...safe } = record;
  return safe;
}

export function registerWhatsAppSettingsRoutes(app: FastifyInstance, db: Db, config: Config, messaging: MessagingProvider) {
  app.get('/api/whatsapp/settings', async (request) => {
    const owner = await requireOwner(db, request);
    return safeConfig(await db.organizationWhatsAppConfig.findUnique({ where: { organizationId: owner.organizationId } }), config.MESSAGING_PROVIDER);
  });

  app.patch('/api/whatsapp/settings', async (request) => {
    const owner = await requireOwner(db, request);
    const input = patchSchema.parse(request.body);
    return db.$transaction(async (tx) => {
      const before = await tx.organizationWhatsAppConfig.findUnique({ where: { organizationId: owner.organizationId } });
      if (before?.provider === 'MSG91' && !config.whatsAppKeys[`${owner.organizationId}:${before.credentialRef}`]) throw new HttpError(409, 'PROVIDER_MANAGED', 'MSG91 credentials must be provisioned by the platform');
      const senderChanged = before?.provider === 'MSG91' && input.senderNumber !== undefined && input.senderNumber !== before.senderNumber;
      if (senderChanged) throw new HttpError(409, 'PROVIDER_MANAGED', 'Changing the connected sender requires platform provisioning');
      const templatesChanged = before?.provider === 'MSG91' && ['templateReceived', 'templateWashing', 'templateReady', 'templateHandedOver'].some((key) => key in input && input[key as keyof typeof input] !== before[key as keyof typeof before]);
      const updated = await tx.organizationWhatsAppConfig.upsert({ where: { organizationId: owner.organizationId }, create: { organizationId: owner.organizationId, ...input }, update: { ...input, ...(templatesChanged ? { templateStatuses: {}, lastVerifiedAt: null, status: 'NOT_CONNECTED' as const } : {}) } });
      await audit(tx, { organizationId: owner.organizationId, actorUserId: owner.id, action: 'WHATSAPP_SETTINGS_UPDATED', entityType: 'OrganizationWhatsAppConfig', entityId: owner.organizationId, before: safeConfig(before), after: safeConfig(updated), ipAddress: request.ip });
      return safeConfig(updated);
    });
  });

  app.post('/api/whatsapp/test-connection', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (request) => {
    const owner = await requireOwner(db, request);
    const settings = await db.organizationWhatsAppConfig.findUnique({ where: { organizationId: owner.organizationId } });
    if (settings?.provider === 'MSG91') {
      const provider = messaging.forProvider?.('MSG91') ?? messaging;
      if (provider.name !== 'MSG91' || !provider.checkConnection) throw new HttpError(409, 'PROVIDER_NOT_READY', 'MSG91 connectivity is not configured');
      let result: { templateStatuses: Record<string, string> };
      try {
        result = await provider.checkConnection({ organizationId: owner.organizationId, credentialRef: settings.credentialRef, integratedNumberId: settings.msg91IntegratedNumberId, senderNumber: settings.senderNumber, templates: [settings.templateReceived, settings.templateWashing, settings.templateReady, ...(settings.templateHandedOver ? [settings.templateHandedOver] : [])] });
      } catch {
        await db.$transaction(async (tx) => {
          await tx.organizationWhatsAppConfig.updateMany({ where: { organizationId: owner.organizationId, updatedAt: settings.updatedAt }, data: { status: 'ERROR', lastVerifiedAt: null, templateStatuses: {} } });
          await audit(tx, { organizationId: owner.organizationId, actorUserId: owner.id, action: 'WHATSAPP_CONNECTION_FAILED', entityType: 'OrganizationWhatsAppConfig', entityId: owner.organizationId, ipAddress: request.ip });
        });
        throw new HttpError(502, 'PROVIDER_CONNECTION_FAILED', 'Connection failed: verify sender credentials and provider access');
      }
      await db.$transaction(async (tx) => {
        const updated = await tx.organizationWhatsAppConfig.updateMany({ where: { organizationId: owner.organizationId, updatedAt: settings.updatedAt }, data: { status: 'CONNECTED', lastVerifiedAt: new Date(), templateStatuses: result.templateStatuses } });
        if (!updated.count) throw new HttpError(409, 'CONFIG_CHANGED', 'Settings changed during verification. Test connection again.');
        await audit(tx, { organizationId: owner.organizationId, actorUserId: owner.id, action: 'WHATSAPP_CONNECTION_VERIFIED', entityType: 'OrganizationWhatsAppConfig', entityId: owner.organizationId, after: { provider: 'MSG91', templateStatuses: result.templateStatuses }, ipAddress: request.ip });
      });
      return { status: 'CONNECTED', delivered: false, message: 'Connected. No customer message was sent.', templateStatuses: result.templateStatuses };
    }
    await audit(db, { organizationId: owner.organizationId, actorUserId: owner.id, action: 'WHATSAPP_MOCK_CONNECTION_TESTED', entityType: 'OrganizationWhatsAppConfig', entityId: owner.organizationId, ipAddress: request.ip });
    return { status: 'MOCK_ACTIVE', delivered: false, message: 'Mock provider active - no real WhatsApp messages are being sent.' };
  });

  app.post('/api/whatsapp/test-failure', async (request) => {
    const owner = await requireOwner(db, request);
    if (config.NODE_ENV === 'production' && !config.stagingMode) throw new HttpError(404, 'NOT_FOUND', 'Not found');
    return db.$transaction(async (tx) => {
      const settings = await tx.organizationWhatsAppConfig.upsert({ where: { organizationId: owner.organizationId }, create: { organizationId: owner.organizationId, mockFailNext: true }, update: { mockFailNext: true } });
      if (settings.provider !== 'MOCK') throw new HttpError(409, 'MOCK_ONLY', 'Failure simulation is available only for mock messaging');
      await audit(tx, { organizationId: owner.organizationId, actorUserId: owner.id, action: 'WHATSAPP_MOCK_FAILURE_ARMED', entityType: 'OrganizationWhatsAppConfig', entityId: owner.organizationId, ipAddress: request.ip });
      return { status: 'armed' };
    });
  });
}
