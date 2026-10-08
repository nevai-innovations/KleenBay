import type { FastifyInstance } from 'fastify';
import { branchCreateSchema, branchUpdateSchema } from '@carwash/shared';
import { z } from 'zod';
import type { Db } from './db.js';
import { audit } from './audit.js';
import { currentUser, requireOwner } from './auth.js';
import { badRequest, notFound } from './errors.js';
import { todayWindow } from './daily-summary.js';

const paramsSchema = z.object({ id: z.string().min(1) });

function formattedAddress(parts: { addressLine1?: string | null; addressLine2?: string | null; city?: string | null; state?: string | null; postalCode?: string | null; country?: string | null }) {
  return [parts.addressLine1, parts.addressLine2, parts.city, parts.state, parts.postalCode, parts.country].filter(Boolean).join(', ');
}

export function registerBranchRoutes(app: FastifyInstance, db: Db) {
  app.get('/api/branches', async (request) => {
    const user = await currentUser(db, request);
    if (user.role === 'EMPLOYEE') {
      if (!user.branchId) return [];
      return db.branch.findMany({ where: { id: user.branchId, organizationId: user.organizationId, active: true }, select: { id: true, name: true, address: true, phone: true, active: true }, orderBy: { name: 'asc' } });
    }
    const branches = await db.branch.findMany({ where: { organizationId: user.organizationId }, orderBy: { name: 'asc' }, include: { _count: { select: { users: { where: { role: 'EMPLOYEE', active: true } }, jobs: { where: { status: { not: 'HANDED_OVER' } } } } } } });
    const todayCounts = await Promise.all(branches.map(async (branch) => {
      const { start, end } = todayWindow(new Date(), branch.timezone);
      return db.job.count({ where: { organizationId: user.organizationId, branchId: branch.id, checkedInAt: { gte: start, lt: end } } });
    }));
    return branches.map((branch, index) => {
      const { _count, ...details } = branch;
      return { ...details, employeeCount: _count.users, activeJobCount: _count.jobs, todayJobCount: todayCounts[index] };
    });
  });

  app.post('/api/branches', async (request, reply) => {
    const owner = await requireOwner(db, request);
    const input = branchCreateSchema.parse(request.body);
    const branch = await db.$transaction(async (tx) => {
      const created = await tx.branch.create({ data: { ...input, code: input.code || null, email: input.email || null, openingTime: input.openingTime || null, closingTime: input.closingTime || null, address: formattedAddress(input), organizationId: owner.organizationId } });
      await audit(tx, { organizationId: owner.organizationId, actorUserId: owner.id, action: 'BRANCH_CREATED', entityType: 'Branch', entityId: created.id, after: { name: created.name, code: created.code, active: created.active }, ipAddress: request.ip });
      return created;
    });
    return reply.code(201).send(branch);
  });

  app.get('/api/branches/:id', async (request) => {
    const owner = await requireOwner(db, request);
    const { id } = paramsSchema.parse(request.params);
    return await db.branch.findFirst({ where: { id, organizationId: owner.organizationId } }) ?? notFound();
  });

  app.patch('/api/branches/:id', async (request) => {
    const owner = await requireOwner(db, request);
    const { id } = paramsSchema.parse(request.params);
    const input = branchUpdateSchema.parse(request.body);
    return db.$transaction(async (tx) => {
      const before = await tx.branch.findFirst({ where: { id, organizationId: owner.organizationId } });
      if (!before) notFound();
      const address = formattedAddress({ ...before, ...input });
      const updated = await tx.branch.update({ where: { id }, data: { ...input, code: input.code === '' ? null : input.code, email: input.email === '' ? null : input.email, openingTime: input.openingTime === '' ? null : input.openingTime, closingTime: input.closingTime === '' ? null : input.closingTime, address } });
      await audit(tx, { organizationId: owner.organizationId, actorUserId: owner.id, action: 'BRANCH_UPDATED', entityType: 'Branch', entityId: id, before: { name: before.name, phone: before.phone, address: before.address, timezone: before.timezone, openingTime: before.openingTime, closingTime: before.closingTime }, after: { name: updated.name, phone: updated.phone, address: updated.address, timezone: updated.timezone, openingTime: updated.openingTime, closingTime: updated.closingTime }, ipAddress: request.ip });
      return updated;
    });
  });

  for (const [operation, active] of [['activate', true], ['deactivate', false]] as const) {
    app.post(`/api/branches/:id/${operation}`, async (request) => {
      const owner = await requireOwner(db, request);
      const { id } = paramsSchema.parse(request.params);
      return db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "Organization" WHERE "id" = ${owner.organizationId} FOR UPDATE`;
        const before = await tx.branch.findFirst({ where: { id, organizationId: owner.organizationId } });
        if (!before) notFound();
        if (before.active === active) return before;
        if (!active && await tx.branch.count({ where: { organizationId: owner.organizationId, active: true } }) <= 1) badRequest('At least one branch must remain active');
        const updated = await tx.branch.update({ where: { id }, data: { active } });
        await audit(tx, { organizationId: owner.organizationId, actorUserId: owner.id, action: active ? 'BRANCH_ACTIVATED' : 'BRANCH_DEACTIVATED', entityType: 'Branch', entityId: id, before: { active: before.active }, after: { active }, ipAddress: request.ip });
        return updated;
      });
    });
  }
}
