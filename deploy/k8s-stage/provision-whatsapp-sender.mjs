import { createDb } from './apps/api/dist/db.js';

// Run via stdin in the stage API pod; one explicitly selected synthetic tenant only.
const organizationId = process.argv[2];
const database = new URL(process.env.DATABASE_URL ?? '');
if (process.env.NODE_ENV !== 'production' || process.env.STAGING_MODE !== 'true' || process.env.POD_NAMESPACE !== 'kleenbay-stage' || process.env.EXPECTED_DATABASE_NAME !== 'kleenbay_stage' || database.pathname !== '/kleenbay_stage' || process.env.APP_ORIGIN !== 'https://stage.kleenbay.com' || process.env.MESSAGING_PROVIDER !== 'mock' || !organizationId) throw new Error('KleenBay stage guard failed');
const db = createDb(process.env.DATABASE_URL);
try {
  const organization = await db.organization.findUniqueOrThrow({ where: { id: organizationId } });
  if (!organization.slug.startsWith('entitlement-qa-') || !organization.name.startsWith('Synthetic Entitlement QA')) throw new Error('Only the controlled synthetic QA organization is permitted');
  const before = await db.organizationWhatsAppConfig.findUnique({ where: { organizationId } });
  await db.$transaction(async (tx) => {
    const data = { provider: 'MSG91', enabled: true, senderNumber: '+918137994052', senderDisplayName: 'NevAi', msg91IntegratedNumberId: '918137994052', credentialRef: 'primary', templateReceived: 'kb_vehicle_received', templateWashing: 'kb_wash_started', templateReady: 'kb_vehicle_ready', templateHandedOver: null, status: 'NOT_CONNECTED', lastVerifiedAt: null, templateStatuses: {} };
    await tx.organizationWhatsAppConfig.upsert({ where: { organizationId }, create: { organizationId, ...data }, update: data });
    await tx.auditLog.create({ data: { organizationId, action: 'WHATSAPP_STAGE_SENDER_PROVISIONED', entityType: 'OrganizationWhatsAppConfig', entityId: organizationId, before: before ? { provider: before.provider, senderNumber: before.senderNumber } : undefined, after: { provider: 'MSG91', senderNumber: data.senderNumber, templates: [data.templateReceived, data.templateWashing, data.templateReady], handoverEnabled: false } } });
  });
  console.log(JSON.stringify({ organizationId, businessName: organization.name, provider: 'MSG91', status: 'NOT_CONNECTED', handoverEnabled: false }));
} finally { await db.$disconnect(); }
