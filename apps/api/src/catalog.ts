import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { customerSchema, customerUpdateSchema, servicePriceSchema, serviceSchema, serviceUpdateSchema, vehicleSchema, vehicleUpdateSchema, type VehicleType } from '@carwash/shared';
import type { Db } from './db.js';
import { audit } from './audit.js';
import { currentUser, requireOwner } from './auth.js';
import { HttpError, notFound } from './errors.js';

const idParams = z.object({ id: z.string().min(1) });
const searchQuery = z.object({ q: z.string().trim().max(120).default('') });

export function registerCatalogRoutes(app: FastifyInstance, db: Db) {
  app.get('/api/customers', async (request) => {
    const user = await currentUser(db, request);
    const { q } = searchQuery.parse(request.query);
    const digits = q.replace(/\D/g, '');
    const plate = q.toUpperCase().replace(/[^A-Z0-9]/g, '');
    return db.customer.findMany({
      where: { organizationId: user.organizationId, ...(q ? { OR: [
        { name: { contains: q, mode: 'insensitive' } },
        ...(digits.length >= 3 ? [{ mobile: { contains: digits } }] : []),
        ...(plate.length >= 2 ? [{ vehicles: { some: { registrationNumber: { contains: plate } } } }] : []),
      ] } : {}) },
      select: { id: true, name: true, mobile: true, alternateMobile: true, email: true, notes: true, tags: true, createdAt: true, vehicles: { select: { id: true, registrationNumber: true, make: true, model: true, type: true } } },
      orderBy: { updatedAt: 'desc' }, take: 50,
    });
  });

  app.post('/api/customers', async (request, reply) => {
    const user = await currentUser(db, request);
    const input = customerSchema.parse(request.body);
    const existing = await db.customer.findUnique({ where: { organizationId_mobile: { organizationId: user.organizationId, mobile: input.mobile } } });
    if (existing) return reply.code(200).send(existing);
    const customer = await db.$transaction(async (tx) => {
      const created = await tx.customer.create({ data: { organizationId: user.organizationId, ...input } });
      await audit(tx, { organizationId: user.organizationId, actorUserId: user.id, action: 'CUSTOMER_CREATED', entityType: 'Customer', entityId: created.id, after: { name: created.name, mobile: created.mobile }, ipAddress: request.ip });
      return created;
    });
    return reply.code(201).send(customer);
  });

  app.get('/api/customers/:id', async (request) => {
    const user = await currentUser(db, request);
    const { id } = idParams.parse(request.params);
    const customer = await db.customer.findFirst({ where: { id, organizationId: user.organizationId }, include: { vehicles: true } });
    if (!customer) notFound();
    return customer;
  });

  app.patch('/api/customers/:id', async (request) => {
    const user = await currentUser(db, request);
    const { id } = idParams.parse(request.params);
    const input = customerUpdateSchema.parse(request.body);
    const before = await db.customer.findFirst({ where: { id, organizationId: user.organizationId } });
    if (!before) notFound();
    return db.$transaction(async (tx) => {
      const updated = await tx.customer.update({ where: { id }, data: input });
      await audit(tx, { organizationId: user.organizationId, actorUserId: user.id, action: 'CUSTOMER_UPDATED', entityType: 'Customer', entityId: id, before: { name: before.name, mobile: before.mobile, notes: before.notes, tags: before.tags }, after: { name: updated.name, mobile: updated.mobile, notes: updated.notes, tags: updated.tags }, ipAddress: request.ip });
      return updated;
    });
  });

  app.get('/api/vehicles', async (request) => {
    const user = await currentUser(db, request);
    const { q } = searchQuery.parse(request.query);
    const plate = q.toUpperCase().replace(/[^A-Z0-9]/g, '');
    const digits = q.replace(/\D/g, '');
    return db.vehicle.findMany({ where: { organizationId: user.organizationId, ...(q ? { OR: [
      ...(plate.length >= 2 ? [{ registrationNumber: { contains: plate } }] : []),
      { customer: { name: { contains: q, mode: 'insensitive' } } },
      ...(digits.length >= 3 ? [{ customer: { mobile: { contains: digits } } }] : []),
    ] } : {}) }, include: { customer: { select: { id: true, name: true, mobile: true } } }, orderBy: { updatedAt: 'desc' }, take: 50 });
  });

  app.post('/api/vehicles', async (request, reply) => {
    const user = await currentUser(db, request);
    const input = vehicleSchema.parse(request.body);
    const customer = await db.customer.findFirst({ where: { id: input.customerId, organizationId: user.organizationId } });
    if (!customer) notFound();
    const existing = await db.vehicle.findUnique({ where: { organizationId_registrationNumber: { organizationId: user.organizationId, registrationNumber: input.registrationNumber } } });
    if (existing) {
      if (existing.customerId !== customer.id) throw new HttpError(409, 'VEHICLE_OWNER_CONFLICT', 'Vehicle is already linked to another customer');
      return reply.code(200).send(existing);
    }
    const vehicle = await db.$transaction(async (tx) => {
      const created = await tx.vehicle.create({ data: { organizationId: user.organizationId, ...input } });
      await audit(tx, { organizationId: user.organizationId, actorUserId: user.id, action: 'VEHICLE_CREATED', entityType: 'Vehicle', entityId: created.id, after: { registrationNumber: created.registrationNumber, customerId: created.customerId }, ipAddress: request.ip });
      return created;
    });
    return reply.code(201).send(vehicle);
  });

  app.get('/api/vehicles/:id', async (request) => {
    const user = await currentUser(db, request);
    const { id } = idParams.parse(request.params);
    const vehicle = await db.vehicle.findFirst({ where: { id, organizationId: user.organizationId }, include: { customer: { select: { id: true, name: true, mobile: true } } } });
    if (!vehicle) notFound();
    return vehicle;
  });

  app.patch('/api/vehicles/:id', async (request) => {
    const user = await currentUser(db, request);
    const { id } = idParams.parse(request.params);
    const input = vehicleUpdateSchema.parse(request.body);
    const before = await db.vehicle.findFirst({ where: { id, organizationId: user.organizationId } });
    if (!before) notFound();
    return db.$transaction(async (tx) => {
      const updated = await tx.vehicle.update({ where: { id }, data: input });
      await audit(tx, { organizationId: user.organizationId, actorUserId: user.id, action: 'VEHICLE_UPDATED', entityType: 'Vehicle', entityId: id, before: { make: before.make, model: before.model, type: before.type, notes: before.notes }, after: { make: updated.make, model: updated.model, type: updated.type, notes: updated.notes }, ipAddress: request.ip });
      return updated;
    });
  });

  app.get('/api/services', async (request) => {
    const user = await currentUser(db, request);
    const services = await db.service.findMany({ where: { organizationId: user.organizationId, ...(user.role === 'EMPLOYEE' ? { active: true, ...(user.branchId ? { OR: [{ branches: { none: { branchId: user.branchId } } }, { branches: { some: { branchId: user.branchId, active: true } } }] } : { id: '__unassigned__' }) } : {}) }, include: { prices: true, branches: true }, orderBy: { name: 'asc' } });
    if (user.role === 'EMPLOYEE') return services.map(({ prices: _prices, branches: _branches, basePricePaise: _basePricePaise, taxRateBps: _taxRateBps, ...operational }) => operational);
    return services;
  });

  app.post('/api/services', async (request, reply) => {
    const owner = await requireOwner(db, request);
    const input = serviceSchema.parse(request.body);
    const service = await db.$transaction(async (tx) => {
      const created = await tx.service.create({ data: { organizationId: owner.organizationId, ...input } });
      await audit(tx, { organizationId: owner.organizationId, actorUserId: owner.id, action: 'SERVICE_CREATED', entityType: 'Service', entityId: created.id, after: { name: created.name, basePricePaise: created.basePricePaise }, ipAddress: request.ip });
      return created;
    });
    return reply.code(201).send(service);
  });

  app.patch('/api/services/:id', async (request) => {
    const owner = await requireOwner(db, request);
    const { id } = idParams.parse(request.params);
    const input = serviceUpdateSchema.parse(request.body);
    const before = await db.service.findFirst({ where: { id, organizationId: owner.organizationId } });
    if (!before) notFound();
    return db.$transaction(async (tx) => {
      const updated = await tx.service.update({ where: { id }, data: input });
      await audit(tx, { organizationId: owner.organizationId, actorUserId: owner.id, action: 'SERVICE_UPDATED', entityType: 'Service', entityId: id, before: { name: before.name, basePricePaise: before.basePricePaise, active: before.active }, after: { name: updated.name, basePricePaise: updated.basePricePaise, active: updated.active }, ipAddress: request.ip });
      return updated;
    });
  });

  app.put('/api/services/:id/prices', async (request) => {
    const owner = await requireOwner(db, request);
    const { id } = idParams.parse(request.params);
    const input = servicePriceSchema.parse(request.body);
    const service = await db.service.findFirst({ where: { id, organizationId: owner.organizationId } });
    if (!service) notFound();
    if (input.branchId && !(await db.branch.findFirst({ where: { id: input.branchId, organizationId: owner.organizationId } }))) notFound();
    return db.$transaction(async (tx) => {
      const old = await tx.servicePrice.findFirst({ where: { serviceId: id, organizationId: owner.organizationId, vehicleType: input.vehicleType, branchId: input.branchId ?? null } });
      const price = old ? await tx.servicePrice.update({ where: { id: old.id }, data: { pricePaise: input.pricePaise } }) : await tx.servicePrice.create({ data: { organizationId: owner.organizationId, serviceId: id, branchId: input.branchId, vehicleType: input.vehicleType, pricePaise: input.pricePaise } });
      await audit(tx, { organizationId: owner.organizationId, actorUserId: owner.id, action: 'SERVICE_PRICE_SET', entityType: 'ServicePrice', entityId: price.id, before: old ? { pricePaise: old.pricePaise } : null, after: { pricePaise: price.pricePaise, branchId: price.branchId, vehicleType: price.vehicleType }, ipAddress: request.ip });
      return price;
    });
  });

  app.put('/api/services/:id/branches/:branchId', async (request) => {
    const owner = await requireOwner(db, request);
    const { id, branchId } = z.object({ id: z.string().min(1), branchId: z.string().min(1) }).parse(request.params);
    const { active } = z.object({ active: z.boolean() }).parse(request.body);
    const [service, branch] = await Promise.all([
      db.service.findFirst({ where: { id, organizationId: owner.organizationId } }),
      db.branch.findFirst({ where: { id: branchId, organizationId: owner.organizationId } }),
    ]);
    if (!service || !branch) notFound();
    return db.$transaction(async (tx) => {
      const before = await tx.serviceBranch.findUnique({ where: { serviceId_branchId: { serviceId: id, branchId } } });
      const availability = await tx.serviceBranch.upsert({ where: { serviceId_branchId: { serviceId: id, branchId } }, create: { organizationId: owner.organizationId, serviceId: id, branchId, active }, update: { active } });
      await audit(tx, { organizationId: owner.organizationId, actorUserId: owner.id, action: 'SERVICE_BRANCH_SET', entityType: 'ServiceBranch', entityId: availability.id, before: before ? { active: before.active } : null, after: { serviceId: id, branchId, active }, ipAddress: request.ip });
      return availability;
    });
  });

  app.get('/api/search', async (request) => {
    const user = await currentUser(db, request);
    const { q } = searchQuery.parse(request.query);
    if (q.length < 2) return { customers: [], vehicles: [] };
    const plate = q.toUpperCase().replace(/[^A-Z0-9]/g, '');
    const digits = q.replace(/\D/g, '');
    const [customers, vehicles] = await Promise.all([
      db.customer.findMany({ where: { organizationId: user.organizationId, OR: [{ name: { contains: q, mode: 'insensitive' } }, ...(digits.length >= 3 ? [{ mobile: { contains: digits } }] : [])] }, select: { id: true, name: true, mobile: true }, take: 10 }),
      plate.length >= 2 ? db.vehicle.findMany({ where: { organizationId: user.organizationId, registrationNumber: { contains: plate } }, select: { id: true, registrationNumber: true, customer: { select: { id: true, name: true, mobile: true } } }, take: 10 }) : Promise.resolve([]),
    ]);
    return { customers, vehicles };
  });
}

export async function resolveServicePrice(db: Db, organizationId: string, serviceId: string, branchId: string, vehicleType: VehicleType) {
  const service = await db.service.findFirst({ where: { id: serviceId, organizationId, active: true } });
  if (!service) notFound();
  const availability = await db.serviceBranch.findUnique({ where: { serviceId_branchId: { serviceId, branchId } } });
  if (availability && !availability.active) notFound();
  const price = await db.servicePrice.findFirst({ where: { organizationId, serviceId, vehicleType, branchId } });
  const global = price ? null : await db.servicePrice.findFirst({ where: { organizationId, serviceId, vehicleType, branchId: null } });
  return { service, pricePaise: price?.pricePaise ?? global?.pricePaise ?? service.basePricePaise };
}
