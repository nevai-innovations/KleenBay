import type { Config } from './config.js';
import { normalizeIndianMobile, type MessageEvent } from '@carwash/shared';
import type { Db } from './db.js';
import { audit } from './audit.js';

export interface MessagingProvider {
  readonly name: 'MOCK' | 'MSG91';
  send(input: { recipient: string; text: string; templateKey: string; idempotencyKey: string; senderNumber?: string | null; senderDisplayName?: string | null; integratedNumberId?: string | null; credentialRef?: string | null }): Promise<{ providerMessageId: string | null }>;
}

export class MockMessagingProvider implements MessagingProvider {
  readonly name = 'MOCK';
  constructor(private readonly fail = false) {}

  async send(input: { idempotencyKey: string }) {
    if (this.fail) throw new Error('Simulated provider failure');
    return { providerMessageId: `mock:${input.idempotencyKey}` };
  }
}

// Reserved adapter boundary; selecting MSG91 stays disabled until WhatsApp is approved.
export class Msg91WhatsAppProvider implements MessagingProvider {
  readonly name = 'MSG91';
  async send(): Promise<{ providerMessageId: string | null }> {
    throw new Error('MSG91 WhatsApp messaging is not enabled');
  }
}

export function createMessagingProvider(config: Config): MessagingProvider {
  if (config.MESSAGING_PROVIDER === 'mock') return new MockMessagingProvider(config.MOCK_MESSAGING_FAIL === 'true');
  throw new Error('MSG91 WhatsApp messaging is not enabled');
}

export function renderCustomerMessage(event: MessageEvent, customerName: string, vehicleNumber: string, businessName: string, trackingUrl?: string) {
  const link = trackingUrl ? ` Track your vehicle: ${trackingUrl}` : '';
  switch (event) {
    case 'VEHICLE_RECEIVED': return `Hi ${customerName}, your vehicle ${vehicleNumber} has been received at ${businessName}. We will keep you updated on the wash progress.${link}`;
    case 'WASH_STARTED': return `Hi ${customerName}, washing has started for your vehicle ${vehicleNumber} at ${businessName}.${link}`;
    case 'VEHICLE_READY': return `Hi ${customerName}, your vehicle ${vehicleNumber} is ready for pickup at ${businessName}. Thank you.${link}`;
    case 'VEHICLE_HANDED_OVER': return `Thank you for visiting ${businessName}. Your vehicle ${vehicleNumber} has been handed over successfully.`;
  }
}

export function messageRecipient(mobile: string) {
  return normalizeIndianMobile(mobile);
}

export async function dispatchMessage(db: Db, provider: MessagingProvider, id: string) {
  const message = await db.message.findUnique({ where: { id } });
  if (!message || message.status !== 'PENDING') return;
  const selectedProvider = message.provider === 'MOCK' ? provider : new Msg91WhatsAppProvider();
  if (selectedProvider.name !== message.provider) throw new Error('Configured messaging provider does not match queued message');
  const claimed = await db.message.updateMany({
    where: { id, status: 'PENDING', attempts: message.attempts },
    data: { attempts: { increment: 1 }, status: 'SENDING' },
  });
  if (!claimed.count) return;
  const attempt = message.attempts + 1;
  try {
    if (message.provider === 'MOCK') {
      const simulated = await db.organizationWhatsAppConfig.updateMany({ where: { organizationId: message.organizationId, provider: 'MOCK', mockFailNext: true }, data: { mockFailNext: false } });
      if (simulated.count) throw new Error('Simulated provider failure');
    }
    const organizationConfig = message.provider === 'MSG91' ? await db.organizationWhatsAppConfig.findUnique({ where: { organizationId: message.organizationId } }) : null;
    const result = await selectedProvider.send({ recipient: message.recipient, text: message.renderedText, templateKey: message.templateKey, idempotencyKey: `${message.jobId}:${message.event}`, senderNumber: message.senderNumber, senderDisplayName: message.senderDisplayName, integratedNumberId: organizationConfig?.msg91IntegratedNumberId ?? null, credentialRef: organizationConfig?.credentialRef ?? null });
    await db.$transaction(async (tx) => {
      await tx.message.update({ where: { id }, data: { status: 'SENT', providerMessageId: result.providerMessageId, sentAt: new Date(), failedAt: null, failureReason: null, nextRetryAt: null } });
      await tx.messageAttempt.create({ data: { organizationId: message.organizationId, messageId: id, number: attempt, status: 'SENT', providerMessageId: result.providerMessageId } });
      await audit(tx, { organizationId: message.organizationId, action: 'MESSAGE_SENT', entityType: 'Message', entityId: id, after: { event: message.event, provider: message.provider, attempt } });
    });
  } catch {
    const reason = message.provider === 'MOCK' ? 'Simulated provider failure' : 'Provider delivery failed';
    await db.$transaction(async (tx) => {
      await tx.message.update({ where: { id }, data: { status: 'FAILED', failedAt: new Date(), failureReason: reason, nextRetryAt: new Date(Date.now() + 5 * 60_000) } });
      await tx.messageAttempt.create({ data: { organizationId: message.organizationId, messageId: id, number: attempt, status: 'FAILED', failureReason: reason } });
      await audit(tx, { organizationId: message.organizationId, action: 'MESSAGE_FAILED', entityType: 'Message', entityId: id, after: { event: message.event, provider: message.provider, attempt } });
    });
  }
}
