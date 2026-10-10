import type { Config } from './config.js';
import { normalizeIndianMobile, type MessageEvent } from '@carwash/shared';
import type { Db } from './db.js';
import { audit } from './audit.js';

export interface MessagingProvider {
  readonly name: 'MOCK' | 'MSG91';
  forProvider?(name: 'MOCK' | 'MSG91'): MessagingProvider;
  checkConnection?(input: { organizationId: string; credentialRef: string | null; integratedNumberId: string | null; senderNumber: string | null; templates: string[] }): Promise<{ templateStatuses: Record<string, string> }>;
  send(input: { recipient: string; text: string; templateKey: string; templateVariables?: string[]; idempotencyKey: string; organizationId?: string; senderNumber?: string | null; senderDisplayName?: string | null; integratedNumberId?: string | null; credentialRef?: string | null }): Promise<{ providerMessageId: string | null }>;
}

export class MockMessagingProvider implements MessagingProvider {
  readonly name = 'MOCK';
  constructor(private readonly fail = false) {}

  async send(input: { idempotencyKey: string }) {
    if (this.fail) throw new Error('Simulated provider failure');
    return { providerMessageId: `mock:${input.idempotencyKey}` };
  }
}

export class Msg91WhatsAppProvider implements MessagingProvider {
  readonly name = 'MSG91';
  constructor(private readonly keys: Record<string, string>, private readonly request: typeof fetch = fetch) {}

  async checkConnection(input: Parameters<NonNullable<MessagingProvider['checkConnection']>>[0]) {
    const authKey = input.credentialRef && this.keys[`${input.organizationId}:${input.credentialRef}`];
    if (!authKey || !input.integratedNumberId || !/^91[6-9]\d{9}$/.test(input.integratedNumberId) || input.senderNumber !== `+${input.integratedNumberId}`) throw new Error('Sender credentials are not configured');
    const read = async (path: string): Promise<unknown> => {
      const response = await this.request(`https://control.msg91.com/api/v5/whatsapp/${path}`, {
        method: 'GET', headers: { accept: 'application/json', authkey: authKey }, signal: AbortSignal.timeout(10_000), redirect: 'error',
      });
      if (!response.ok) throw new Error(response.status === 401 || response.status === 403 ? 'Provider authentication was rejected' : 'Provider connectivity check failed');
      const body: unknown = await response.json();
      if (!body || typeof body !== 'object' || ('success' in body && body.success === false) || ('type' in body && body.type === 'error') || ('status' in body && ['error', 'failed', 'failure'].includes(String(body.status).toLowerCase()))) throw new Error('Provider connectivity check failed');
      return body;
    };
    const numbers = providerRows(await read('whatsapp-activation/'));
    const sender = numbers.find((row) => String(row.integrated_number ?? row.number ?? row.phone_number ?? '').replace(/\D/g, '') === input.integratedNumberId);
    if (!sender) throw new Error('Configured sender was not found in this provider account');
    if (['inactive', 'disabled', 'disconnected', 'failed'].includes(String(sender.status ?? '').toLowerCase())) throw new Error('Configured sender is not active');
    const templateStatuses: Record<string, string> = {};
    for (const name of input.templates) {
      if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new Error('Invalid template configuration');
      try {
        const rows = providerRows(await read(`get-template-client/${input.integratedNumberId}?template_name=${encodeURIComponent(name)}`));
        const row = rows.find((item) => (item.name ?? item.template_name) === name && (!item.language || item.language === 'en'));
        const status = String(row?.status ?? row?.template_status ?? 'NOT_FOUND').toUpperCase();
        templateStatuses[name] = ['APPROVED', 'REJECTED', 'PAUSED', 'DISABLED', 'NOT_FOUND'].includes(status) ? status : ['PENDING', 'IN_REVIEW'].includes(status) ? 'IN_REVIEW' : 'UNKNOWN';
      } catch { templateStatuses[name] = 'UNKNOWN'; }
    }
    return { templateStatuses };
  }

  async send(input: Parameters<MessagingProvider['send']>[0]): Promise<{ providerMessageId: string | null }> {
    const authKey = input.organizationId && input.credentialRef && this.keys[`${input.organizationId}:${input.credentialRef}`];
    if (!authKey || !input.integratedNumberId || !input.senderNumber || !/^\+91[6-9]\d{9}$/.test(input.recipient) || !input.templateVariables?.length || input.templateVariables.length > 10 || !/^[A-Za-z0-9_-]+$/.test(input.templateKey)) {
      throw new Error('MSG91 sender or approved template is not configured');
    }
    const components = Object.fromEntries(input.templateVariables.map((value, index) => [`body_${index + 1}`, { type: 'text', value }]));
    const response = await this.request('https://control.msg91.com/api/v5/whatsapp/whatsapp-outbound-message/bulk/', {
      method: 'POST',
      headers: { accept: 'application/json', authkey: authKey, 'content-type': 'application/json' },
      body: JSON.stringify({ integrated_number: input.integratedNumberId, content_type: 'template', payload: {
        type: 'template', template: { name: input.templateKey, language: { code: 'en', policy: 'deterministic' },
          to_and_components: [{ to: [input.recipient.replace(/^\+/, '')], components }] }, messaging_product: 'whatsapp',
      } }),
      signal: AbortSignal.timeout(10_000),
      redirect: 'error',
    });
    if (!response.ok) throw new Error('MSG91 rejected the message');
    const payload: unknown = await response.json();
    if (!payload || typeof payload !== 'object' || ('success' in payload && payload.success === false) || ('type' in payload && payload.type === 'error') || ('status' in payload && ['error', 'failed', 'failure'].includes(String(payload.status).toLowerCase()))) throw new Error('MSG91 rejected the message');
    const result = payload as Record<string, unknown>;
    const id = result.message_id ?? result.messageId ?? result.request_id;
    return { providerMessageId: typeof id === 'string' ? id : null };
  }
}

// Only inspect documented list containers; never return raw provider payloads.
function providerRows(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.filter((row): row is Record<string, unknown> => !!row && typeof row === 'object' && !Array.isArray(row));
  if (!value || typeof value !== 'object') return [];
  const record = value as Record<string, unknown>;
  for (const key of ['data', 'results', 'numbers', 'templates']) {
    if (record[key]) return providerRows(record[key]);
  }
  return [];
}

export function createMessagingProvider(config: Config): MessagingProvider {
  const mock = new MockMessagingProvider(config.MOCK_MESSAGING_FAIL === 'true');
  const msg91 = new Msg91WhatsAppProvider(config.whatsAppKeys);
  return {
    name: config.MESSAGING_PROVIDER === 'mock' ? 'MOCK' : 'MSG91',
    forProvider(name) {
      if (name === 'MOCK' && config.NODE_ENV === 'production' && !config.stagingMode) throw new Error('Mock messaging is not permitted in production');
      return name === 'MOCK' ? mock : msg91;
    },
    send(input) { return (config.MESSAGING_PROVIDER === 'mock' ? mock : msg91).send(input); },
  };
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
  const claimed = await db.message.updateMany({
    where: { id, status: 'PENDING', attempts: message.attempts },
    data: { attempts: { increment: 1 }, status: 'SENDING' },
  });
  if (!claimed.count) return;
  const attempt = message.attempts + 1;
  try {
    const selectedProvider = provider.forProvider?.(message.provider) ?? provider;
    if (selectedProvider.name !== message.provider) throw new Error('Configured messaging provider does not match queued message');
    if (message.provider === 'MOCK') {
      const simulated = await db.organizationWhatsAppConfig.updateMany({ where: { organizationId: message.organizationId, provider: 'MOCK', mockFailNext: true }, data: { mockFailNext: false } });
      if (simulated.count) throw new Error('Simulated provider failure');
    }
    const organizationConfig = message.provider === 'MSG91' ? await db.organizationWhatsAppConfig.findUnique({ where: { organizationId: message.organizationId } }) : null;
    if (message.provider === 'MSG91' && (!organizationConfig?.enabled || organizationConfig.provider !== 'MSG91' || organizationConfig.status !== 'CONNECTED')) throw new Error('MSG91 sender is not active');
    if (message.provider === 'MSG91' && (organizationConfig?.templateStatuses as Record<string, unknown> | null)?.[message.templateKey] !== 'APPROVED') throw new Error('Template approval has not been verified');
    const variables = message.templateVariables;
    const result = await selectedProvider.send({ recipient: message.recipient, text: message.renderedText, templateKey: message.templateKey, templateVariables: Array.isArray(variables) && variables.every((item) => typeof item === 'string') ? variables as string[] : undefined, idempotencyKey: `${message.jobId}:${message.event}`, organizationId: message.organizationId, senderNumber: message.senderNumber, senderDisplayName: message.senderDisplayName, integratedNumberId: organizationConfig?.msg91IntegratedNumberId ?? null, credentialRef: organizationConfig?.credentialRef ?? null });
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
