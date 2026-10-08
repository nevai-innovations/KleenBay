import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { invoiceDraftSchema, invoiceSettingsSchema, saleItemSchema } from '@carwash/shared';
import { Prisma } from './generated/prisma/client.js';
import type { Db } from './db.js';
import { audit } from './audit.js';
import { currentUser, requireOwner } from './auth.js';
import { badRequest, forbidden, HttpError, notFound } from './errors.js';
import { calculateInvoice, type PriceLine } from './invoice-calculation.js';

const idParams = z.object({ id: z.string().min(1) });
const invoiceInclude = {
  items: { orderBy: { position: 'asc' as const } },
  payments: { include: { collectedBy: { select: { name: true } } }, orderBy: { createdAt: 'asc' as const } },
  job: { select: { number: true, serviceName: true, status: true, checkedInAt: true, customer: { select: { name: true, mobile: true } }, vehicle: { select: { registrationNumber: true, make: true, model: true } }, branch: { select: { name: true, address: true, phone: true } } } },
  organization: { select: { name: true, gstin: true, invoiceAddress: true, invoicePhone: true, currency: true } },
};

export async function activeInvoice(tx: Prisma.TransactionClient, organizationId: string, jobId: string) {
  return tx.invoice.findFirst({ where: { organizationId, jobId, status: { not: 'CANCELLED' } } });
}

export async function prepareInvoice(tx: Prisma.TransactionClient, organizationId: string, jobId: string, actorUserId: string, ipAddress: string, input: z.infer<typeof invoiceDraftSchema>) {
  await tx.$queryRaw`SELECT "id" FROM "Job" WHERE "id" = ${jobId} AND "organizationId" = ${organizationId} FOR UPDATE`;
  const job = await tx.job.findFirst({ where: { id: jobId, organizationId }, include: { organization: true } });
  if (!job) notFound();
  const current = await activeInvoice(tx, organizationId, jobId);
  if (current && current.status !== 'DRAFT') throw new HttpError(409, 'INVOICE_LOCKED', 'Issued invoices cannot be edited');
  if (job.status === 'HANDED_OVER') throw new HttpError(409, 'JOB_CLOSED', 'Invoice cannot be prepared after handover');
  if (input.items.some((item) => item.kind === 'CUSTOM') && !job.organization.allowCustomInvoiceItems) forbidden();
  const saleIds = input.items.filter((item) => item.kind !== 'CUSTOM').map((item) => item.saleItemId);
  const catalog = await tx.saleItem.findMany({ where: { organizationId, id: { in: saleIds }, active: true } });
  if (catalog.length !== new Set(saleIds).size) badRequest('Choose active add-ons or products from this business');
  const byId = new Map(catalog.map((item) => [item.id, item]));
  const serviceRate = job.organization.gstRateBps ?? job.serviceTaxRateBps;
  const lines: PriceLine[] = [{ kind: 'SERVICE', description: job.serviceName, quantity: 1, unitPricePaise: job.servicePricePaise, taxRateBps: serviceRate }];
  for (const item of input.items) {
    if (item.kind === 'CUSTOM') lines.push({ kind: 'CUSTOM', description: item.description, quantity: item.quantity, unitPricePaise: item.unitPricePaise, taxRateBps: job.organization.gstRateBps ?? 0 });
    else {
      const selected = byId.get(item.saleItemId);
      if (!selected || selected.kind !== item.kind) badRequest('Catalog item does not match its type');
      lines.push({ kind: item.kind, description: selected.name, quantity: item.quantity, unitPricePaise: selected.pricePaise, taxRateBps: job.organization.gstRateBps ?? 0, saleItemId: selected.id });
    }
  }
  let calculation: ReturnType<typeof calculateInvoice>;
  try { calculation = calculateInvoice(lines, input.discountKind, input.discountValue); }
  catch (error) { badRequest(error instanceof Error ? error.message : 'Invalid invoice'); }
  let invoice = current;
  if (!invoice) {
    const org = await tx.organization.update({ where: { id: organizationId }, data: { nextInvoiceNumber: { increment: 1 } }, select: { nextInvoiceNumber: true, invoicePrefix: true, timezone: true } });
    const year = new Intl.DateTimeFormat('en-US', { timeZone: org.timezone, year: 'numeric' }).format(new Date());
    const lastCancelled = await tx.invoice.findFirst({ where: { organizationId, jobId, status: 'CANCELLED' }, orderBy: { createdAt: 'desc' } });
    invoice = await tx.invoice.create({ data: { organizationId, jobId, invoiceNumber: `${org.invoicePrefix}-${year}-${String(org.nextInvoiceNumber - 1).padStart(6, '0')}`, replacesInvoiceId: lastCancelled?.id, subtotalPaise: calculation.subtotalPaise, discountKind: calculation.discountKind, discountValue: calculation.discountValue, discountPaise: calculation.discountPaise, taxablePaise: calculation.taxablePaise, taxPaise: calculation.taxPaise, totalPaise: calculation.totalPaise } });
    await audit(tx, { organizationId, actorUserId, action: lastCancelled ? 'INVOICE_REISSUE_DRAFT_CREATED' : 'INVOICE_CREATED', entityType: 'Invoice', entityId: invoice.id, after: { invoiceNumber: invoice.invoiceNumber, totalPaise: invoice.totalPaise, replacesInvoiceId: lastCancelled?.id }, ipAddress });
  } else {
    await tx.invoiceItem.deleteMany({ where: { invoiceId: invoice.id, organizationId } });
    invoice = await tx.invoice.update({ where: { id: invoice.id }, data: { subtotalPaise: calculation.subtotalPaise, discountKind: calculation.discountKind, discountValue: calculation.discountValue, discountPaise: calculation.discountPaise, taxablePaise: calculation.taxablePaise, taxPaise: calculation.taxPaise, totalPaise: calculation.totalPaise } });
    await audit(tx, { organizationId, actorUserId, action: 'INVOICE_DRAFT_UPDATED', entityType: 'Invoice', entityId: invoice.id, after: { totalPaise: invoice.totalPaise, discountPaise: invoice.discountPaise }, ipAddress });
  }
  await tx.invoiceItem.createMany({ data: calculation.items.map((item, position) => ({ organizationId, invoiceId: invoice.id, position, kind: item.kind, description: item.description, quantity: item.quantity, unitPricePaise: item.unitPricePaise, subtotalPaise: item.subtotalPaise, taxRateBps: item.taxRateBps, taxPaise: item.taxPaise, totalPaise: item.totalPaise, saleItemId: item.saleItemId })) });
  if (input.discountKind !== 'NONE' && input.discountValue > 0) await audit(tx, { organizationId, actorUserId, action: 'INVOICE_DISCOUNT_APPLIED', entityType: 'Invoice', entityId: invoice.id, after: { kind: input.discountKind, value: input.discountValue, discountPaise: calculation.discountPaise }, ipAddress });
  return invoice;
}

export async function issueInvoice(tx: Prisma.TransactionClient, invoiceId: string, organizationId: string, actorUserId: string, ipAddress: string) {
  await tx.$queryRaw`SELECT "id" FROM "Invoice" WHERE "id" = ${invoiceId} AND "organizationId" = ${organizationId} FOR UPDATE`;
  const invoice = await tx.invoice.findFirst({ where: { id: invoiceId, organizationId } });
  if (!invoice) notFound();
  if (invoice.status === 'CANCELLED') throw new HttpError(409, 'INVOICE_CANCELLED', 'Cancelled invoices cannot be issued');
  if (invoice.status !== 'DRAFT') return invoice;
  const issued = await tx.invoice.update({ where: { id: invoice.id }, data: { status: invoice.totalPaise === 0 ? 'PAID' : 'ISSUED', issuedAt: new Date() } });
  await tx.job.update({ where: { id: invoice.jobId }, data: { subtotalPaise: issued.subtotalPaise, taxPaise: issued.taxPaise, totalPaise: issued.totalPaise } });
  await audit(tx, { organizationId, actorUserId, action: 'INVOICE_ISSUED', entityType: 'Invoice', entityId: invoice.id, after: { invoiceNumber: invoice.invoiceNumber, totalPaise: issued.totalPaise }, ipAddress });
  return issued;
}

export function registerInvoiceRoutes(app: FastifyInstance, db: Db) {
  app.get('/api/invoice-settings', async (request) => {
    const owner = await requireOwner(db, request);
    return db.organization.findUniqueOrThrow({ where: { id: owner.organizationId }, select: { gstRateBps: true, gstin: true, invoiceAddress: true, invoicePhone: true, allowCustomInvoiceItems: true, employeeAddons: true } });
  });
  app.patch('/api/invoice-settings', async (request) => {
    const owner = await requireOwner(db, request);
    const input = invoiceSettingsSchema.parse(request.body);
    return db.$transaction(async (tx) => {
      const before = await tx.organization.findUniqueOrThrow({ where: { id: owner.organizationId }, select: { gstRateBps: true, gstin: true, invoiceAddress: true, invoicePhone: true, allowCustomInvoiceItems: true, employeeAddons: true } });
      const updated = await tx.organization.update({ where: { id: owner.organizationId }, data: input, select: { gstRateBps: true, gstin: true, invoiceAddress: true, invoicePhone: true, allowCustomInvoiceItems: true, employeeAddons: true } });
      await audit(tx, { organizationId: owner.organizationId, actorUserId: owner.id, action: 'INVOICE_SETTINGS_UPDATED', entityType: 'Organization', entityId: owner.organizationId, before, after: updated, ipAddress: request.ip });
      return updated;
    });
  });
  app.get('/api/sale-items', async (request) => {
    const user = await currentUser(db, request);
    const items = await db.saleItem.findMany({ where: { organizationId: user.organizationId, ...(user.role === 'EMPLOYEE' ? { active: true } : {}) }, orderBy: [{ kind: 'asc' }, { name: 'asc' }] });
    return user.role === 'OWNER' ? items : items.map(({ id, kind, name }) => ({ id, kind, name }));
  });
  app.post('/api/sale-items', async (request, reply) => {
    const owner = await requireOwner(db, request);
    const input = saleItemSchema.parse(request.body);
    const item = await db.$transaction(async (tx) => {
      const created = await tx.saleItem.create({ data: { organizationId: owner.organizationId, ...input } });
      await audit(tx, { organizationId: owner.organizationId, actorUserId: owner.id, action: 'SALE_ITEM_CREATED', entityType: 'SaleItem', entityId: created.id, after: { name: created.name, kind: created.kind, pricePaise: created.pricePaise }, ipAddress: request.ip });
      return created;
    });
    return reply.code(201).send(item);
  });
  app.patch('/api/sale-items/:id', async (request) => {
    const owner = await requireOwner(db, request);
    const { id } = idParams.parse(request.params);
    const input = saleItemSchema.partial().parse(request.body);
    return db.$transaction(async (tx) => {
      const before = await tx.saleItem.findFirst({ where: { id, organizationId: owner.organizationId } });
      if (!before) notFound();
      const item = await tx.saleItem.update({ where: { id }, data: input });
      await audit(tx, { organizationId: owner.organizationId, actorUserId: owner.id, action: 'SALE_ITEM_UPDATED', entityType: 'SaleItem', entityId: id, before: { name: before.name, pricePaise: before.pricePaise, active: before.active }, after: { name: item.name, pricePaise: item.pricePaise, active: item.active }, ipAddress: request.ip });
      return item;
    });
  });
  app.post('/api/jobs/:id/invoice', async (request, reply) => {
    const owner = await requireOwner(db, request);
    const { id } = idParams.parse(request.params);
    const input = invoiceDraftSchema.parse(request.body);
    const invoice = await db.$transaction((tx) => prepareInvoice(tx, owner.organizationId, id, owner.id, request.ip, input));
    return reply.code(201).send(await db.invoice.findUniqueOrThrow({ where: { id: invoice.id }, include: invoiceInclude }));
  });
  app.post('/api/jobs/:id/add-ons', async (request) => {
    const employee = await currentUser(db, request);
    if (employee.role !== 'EMPLOYEE') forbidden();
    const { id } = idParams.parse(request.params);
    const { saleItemId, quantity } = z.object({ saleItemId: z.string().min(1), quantity: z.number().int().min(1).max(100) }).parse(request.body);
    await db.$transaction(async (tx) => {
      const org = await tx.organization.findUniqueOrThrow({ where: { id: employee.organizationId }, select: { employeeAddons: true } });
      if (!org.employeeAddons) forbidden();
      const job = await tx.job.findFirst({ where: { id, organizationId: employee.organizationId, branchId: employee.branchId ?? '__unassigned__', status: { not: 'HANDED_OVER' } } });
      if (!job) notFound();
      const item = await tx.saleItem.findFirst({ where: { id: saleItemId, organizationId: employee.organizationId, kind: 'ADD_ON', active: true } });
      if (!item) notFound();
      const existing = await activeInvoice(tx, employee.organizationId, id);
      if (existing?.status !== 'DRAFT' && existing) throw new HttpError(409, 'INVOICE_LOCKED', 'Add-ons cannot change after invoice issue');
      const prior = existing ? await tx.invoiceItem.findMany({ where: { invoiceId: existing.id, kind: { not: 'SERVICE' } } }) : [];
      const input = invoiceDraftSchema.parse({ items: [...prior.map((line) => line.kind === 'CUSTOM' ? { kind: 'CUSTOM', description: line.description, quantity: line.quantity, unitPricePaise: line.unitPricePaise } : { kind: line.kind, saleItemId: line.saleItemId!, quantity: line.quantity }), { kind: 'ADD_ON', saleItemId, quantity }], discountKind: existing?.discountKind ?? 'NONE', discountValue: existing?.discountValue ?? 0 });
      await prepareInvoice(tx, employee.organizationId, id, employee.id, request.ip, input);
      await audit(tx, { organizationId: employee.organizationId, actorUserId: employee.id, action: 'JOB_ADD_ON_SELECTED', entityType: 'Job', entityId: id, after: { saleItemId, quantity }, ipAddress: request.ip });
    });
    return { status: 'added' };
  });
  app.post('/api/invoices/:id/issue', async (request) => {
    const owner = await requireOwner(db, request);
    const { id } = idParams.parse(request.params);
    await db.$transaction((tx) => issueInvoice(tx, id, owner.organizationId, owner.id, request.ip));
    return db.invoice.findFirstOrThrow({ where: { id, organizationId: owner.organizationId }, include: invoiceInclude });
  });
  app.post('/api/invoices/:id/cancel', async (request) => {
    const owner = await requireOwner(db, request);
    const { id } = idParams.parse(request.params);
    const { reason } = z.object({ reason: z.string().trim().min(5).max(500) }).parse(request.body);
    return db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Invoice" WHERE "id" = ${id} AND "organizationId" = ${owner.organizationId} FOR UPDATE`;
      const invoice = await tx.invoice.findFirst({ where: { id, organizationId: owner.organizationId }, include: { job: true, payments: true } });
      if (!invoice) notFound();
      if (invoice.status === 'CANCELLED') return invoice;
      if (invoice.payments.length) throw new HttpError(409, 'PAYMENTS_EXIST', 'An invoice with payments cannot be cancelled');
      if (invoice.job.status === 'HANDED_OVER') throw new HttpError(409, 'JOB_CLOSED', 'Handed-over invoices cannot be cancelled');
      const cancelled = await tx.invoice.update({ where: { id }, data: { status: 'CANCELLED', cancelledAt: new Date() } });
      await audit(tx, { organizationId: owner.organizationId, actorUserId: owner.id, action: 'INVOICE_CANCELLED', entityType: 'Invoice', entityId: id, before: { status: invoice.status }, after: { reason }, ipAddress: request.ip });
      return cancelled;
    });
  });
  app.get('/api/invoices', async (request) => {
    const owner = await requireOwner(db, request);
    const { q, from, to, customerId, vehicleId, branchId } = z.object({ q: z.string().trim().max(120).default(''), from: z.iso.date().optional(), to: z.iso.date().optional(), customerId: z.string().optional(), vehicleId: z.string().optional(), branchId: z.string().optional() }).parse(request.query);
    if (branchId && !await db.branch.findFirst({ where: { id: branchId, organizationId: owner.organizationId } })) notFound();
    const number = q.toUpperCase().replace(/[^A-Z0-9]/g, '');
    const digits = q.replace(/\D/g, '');
    const invoices = await db.invoice.findMany({ where: { organizationId: owner.organizationId, ...(customerId || vehicleId || branchId ? { job: { ...(customerId ? { customerId } : {}), ...(vehicleId ? { vehicleId } : {}), ...(branchId ? { branchId } : {}) } } : {}), ...(from || to ? { createdAt: { ...(from ? { gte: new Date(`${from}T00:00:00.000Z`) } : {}), ...(to ? { lt: new Date(new Date(`${to}T00:00:00.000Z`).getTime() + 86_400_000) } : {}) } } : {}), ...(q ? { OR: [
      { invoiceNumber: { contains: q, mode: 'insensitive' } },
      { job: { customer: { name: { contains: q, mode: 'insensitive' } } } },
      ...(digits.length >= 3 ? [{ job: { customer: { mobile: { contains: digits } } } }] : []),
      ...(number.length >= 2 ? [{ job: { vehicle: { registrationNumber: { contains: number } } } }] : []),
    ] } : {}) }, include: { job: { select: { customer: { select: { name: true, mobile: true } }, vehicle: { select: { registrationNumber: true } }, branch: { select: { id: true, name: true } }, number: true } }, payments: { select: { amountPaise: true } } }, orderBy: { createdAt: 'desc' }, take: 150 });
    return invoices.map((invoice) => ({ ...invoice, paidPaise: invoice.payments.reduce((sum, payment) => sum + payment.amountPaise, 0), outstandingPaise: Math.max(0, invoice.totalPaise - invoice.payments.reduce((sum, payment) => sum + payment.amountPaise, 0)) }));
  });
  app.get('/api/payments', async (request) => {
    const owner = await requireOwner(db, request);
    const { branchId } = z.object({ branchId: z.string().optional() }).parse(request.query);
    if (branchId && !await db.branch.findFirst({ where: { id: branchId, organizationId: owner.organizationId } })) notFound();
    return db.payment.findMany({ where: { organizationId: owner.organizationId, ...(branchId ? { invoice: { job: { branchId } } } : {}) }, select: { id: true, amountPaise: true, method: true, reference: true, createdAt: true, collectedBy: { select: { name: true } }, invoice: { select: { id: true, invoiceNumber: true, job: { select: { branch: { select: { id: true, name: true } }, vehicle: { select: { registrationNumber: true } } } } } } }, orderBy: { createdAt: 'desc' }, take: 150 });
  });
  app.get('/api/invoices/:id', async (request) => {
    const owner = await requireOwner(db, request);
    const { id } = idParams.parse(request.params);
    const invoice = await db.invoice.findFirst({ where: { id, organizationId: owner.organizationId }, include: invoiceInclude });
    if (!invoice) notFound();
    const paidPaise = invoice.payments.reduce((sum, payment) => sum + payment.amountPaise, 0);
    return { ...invoice, paidPaise, outstandingPaise: Math.max(0, invoice.totalPaise - paidPaise) };
  });
}
