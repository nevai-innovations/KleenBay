import type { Db } from './db.js';
import { audit } from './audit.js';

export interface MessagingProvider {
  send(input: { recipient: string; text: string; idempotencyKey: string }): Promise<{ providerMessageId: string }>;
}

export class LocalMessagingProvider implements MessagingProvider {
  async send(input: { idempotencyKey: string }) {
    return { providerMessageId: `local:${input.idempotencyKey}` };
  }
}

export class DisabledMessagingProvider implements MessagingProvider {
  async send(): Promise<{ providerMessageId: string }> {
    throw new Error('Messaging provider is not configured');
  }
}

export async function dispatchMessage(db: Db, provider: MessagingProvider, id: string) {
  const message = await db.message.findUnique({ where: { id } });
  if (!message || message.status !== 'PENDING') return;
  const claimed = await db.message.updateMany({
    where: { id, status: 'PENDING', attempts: message.attempts },
    data: { attempts: { increment: 1 }, status: 'SENDING' },
  });
  if (!claimed.count) return;
  try {
    const result = await provider.send({ recipient: message.recipient, text: message.renderedText, idempotencyKey: `${message.jobId}:${message.event}` });
    await db.$transaction(async (tx) => {
      await tx.message.update({ where: { id }, data: { status: 'SENT', providerMessageId: result.providerMessageId, sentAt: new Date(), failedAt: null, failureReason: null } });
      await audit(tx, { organizationId: message.organizationId, action: 'MESSAGE_SENT', entityType: 'Message', entityId: id, after: { event: message.event, providerMessageId: result.providerMessageId } });
    });
  } catch {
    await db.$transaction(async (tx) => {
      await tx.message.update({ where: { id }, data: { status: 'FAILED', failedAt: new Date(), failureReason: 'Provider delivery failed' } });
      await audit(tx, { organizationId: message.organizationId, action: 'MESSAGE_FAILED', entityType: 'Message', entityId: id, after: { event: message.event } });
    });
  }
}
