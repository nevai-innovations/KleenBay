import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { normalizeIndianMobile } from '@carwash/shared';
import type { Db } from './db.js';
import type { Config } from './config.js';
import { audit } from './audit.js';
import { requireOwner } from './auth.js';
import { HttpError } from './errors.js';

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
};

function safeConfig(record: Awaited<ReturnType<Db['organizationWhatsAppConfig']['findUnique']>>, provider: 'mock' | 'msg91' = 'mock') {
  if (!record) return provider === 'msg91' ? { ...defaults, provider: 'MSG91' as const, status: 'NOT_CONNECTED' as const } : defaults;
  const { credentialRef: _secretRef, mockFailNext: _mockFailNext, organizationId: _organizationId, createdAt: _createdAt, updatedAt: _updatedAt, ...safe } = record;
  return safe;
}

export function registerWhatsAppSettingsRoutes(app: FastifyInstance, db: Db, config: Config) {
  app.get('/api/whatsapp/settings', async (request) => {
    const owner = await requireOwner(db, request);
    return safeConfig(await db.organizationWhatsAppConfig.findUnique({ where: { organizationId: owner.organizationId } }), config.MESSAGING_PROVIDER);
  });

  app.patch('/api/whatsapp/settings', async (request) => {
    const owner = await requireOwner(db, request);
    const input = patchSchema.parse(request.body);
    return db.$transaction(async (tx) => {
      const before = await tx.organizationWhatsAppConfig.findUnique({ where: { organizationId: owner.organizationId } });
      if (config.MESSAGING_PROVIDER === 'msg91' && (!before || before.provider !== 'MSG91')) throw new HttpError(409, 'PROVIDER_MANAGED', 'MSG91 sender must be provisioned by the platform');
      if (before?.provider === 'MSG91' && (config.MESSAGING_PROVIDER !== 'msg91' || Object.keys(input).some((key) => key !== 'enabled'))) throw new HttpError(409, 'PROVIDER_MANAGED', 'MSG91 sender and templates are platform-managed');
      const updated = await tx.organizationWhatsAppConfig.upsert({ where: { organizationId: owner.organizationId }, create: { organizationId: owner.organizationId, ...input }, update: input });
      await audit(tx, { organizationId: owner.organizationId, actorUserId: owner.id, action: 'WHATSAPP_SETTINGS_UPDATED', entityType: 'OrganizationWhatsAppConfig', entityId: owner.organizationId, before: safeConfig(before), after: safeConfig(updated), ipAddress: request.ip });
      return safeConfig(updated);
    });
  });

  app.post('/api/whatsapp/test-connection', async (request) => {
    const owner = await requireOwner(db, request);
    const settings = await db.organizationWhatsAppConfig.findUnique({ where: { organizationId: owner.organizationId } });
    if (settings?.provider === 'MSG91') throw new HttpError(409, 'PROVIDER_NOT_READY', 'MSG91 WhatsApp onboarding is not complete');
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
