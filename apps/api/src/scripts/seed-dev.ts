import { randomBytes } from 'node:crypto';
import { hash } from '@node-rs/argon2';
import { createDb } from '../db.js';
import { getConfig } from '../config.js';

const config = getConfig();
if (config.NODE_ENV === 'production') throw new Error('Development seed cannot run in production');
const db = createDb(config.DATABASE_URL);
const password = process.env.DEV_SEED_PASSWORD || randomBytes(18).toString('base64url');

try {
  const org = await db.organization.upsert({ where: { slug: 'sparkle' }, update: {}, create: { slug: 'sparkle', name: 'Sparkle Car Wash' } });
  const branch = await db.branch.upsert({ where: { organizationId_name: { organizationId: org.id, name: 'Main Branch' } }, update: {}, create: { organizationId: org.id, name: 'Main Branch' } });
  const owner = await db.user.findFirst({ where: { organizationId: org.id, username: 'suresh' } });
  if (!owner) await db.user.create({ data: { organizationId: org.id, branchId: branch.id, role: 'OWNER', name: 'Suresh', username: 'suresh', email: 'suresh@example.local', passwordHash: await hash(password) } });
  else if (process.env.DEV_SEED_PASSWORD) await db.user.update({ where: { id: owner.id }, data: { passwordHash: await hash(password) } });
  for (const [name, mobile] of [['Ravi', '+919876543210'], ['Salim', '+919876543211'], ['Anu', '+919876543212']] as const) {
    const exists = await db.employeeProfile.findUnique({ where: { organizationId_mobile: { organizationId: org.id, mobile } } });
    if (!exists) await db.user.create({ data: { organizationId: org.id, branchId: branch.id, role: 'EMPLOYEE', name, employee: { create: { mobile } } } });
  }
  const serviceFixtures = [
    ['Basic Wash', 'Wash', 29900, 30],
    ['Premium Wash', 'Wash', 59900, 45],
    ['Exterior Wash', 'Wash', 19900, 20],
    ['Interior Cleaning', 'Interior', 49900, 40],
    ['Full Detailing', 'Detailing', 249900, 180],
  ] as const;
  for (const [name, category, basePricePaise, estimatedMinutes] of serviceFixtures) {
    const service = await db.service.upsert({ where: { organizationId_name: { organizationId: org.id, name } }, update: {}, create: { organizationId: org.id, name, category, basePricePaise, estimatedMinutes } });
    if (name === 'Premium Wash') {
      for (const [vehicleType, pricePaise] of [['HATCHBACK', 49900], ['SEDAN', 59900], ['SUV', 69900]] as const) {
        const price = await db.servicePrice.findFirst({ where: { serviceId: service.id, vehicleType, branchId: null } });
        if (!price) await db.servicePrice.create({ data: { organizationId: org.id, serviceId: service.id, vehicleType, pricePaise } });
      }
    }
  }
  const customerFixtures = [
    { name: 'Meera Nair', mobile: '+919845612300', plate: 'KL07AB1234', make: 'Hyundai', model: 'i20', type: 'HATCHBACK' as const },
    { name: 'Arjun Shah', mobile: '+919845612301', plate: '22BH1234AA', make: 'Tata', model: 'Nexon', type: 'SUV' as const },
    { name: 'Priya Menon', mobile: '+919845612302', plate: 'KA03MN4567', make: 'Honda', model: 'City', type: 'SEDAN' as const },
  ];
  for (const fixture of customerFixtures) {
    const customer = await db.customer.upsert({ where: { organizationId_mobile: { organizationId: org.id, mobile: fixture.mobile } }, update: {}, create: { organizationId: org.id, name: fixture.name, mobile: fixture.mobile } });
    await db.vehicle.upsert({ where: { organizationId_registrationNumber: { organizationId: org.id, registrationNumber: fixture.plate } }, update: {}, create: { organizationId: org.id, customerId: customer.id, registrationNumber: fixture.plate, make: fixture.make, model: fixture.model, type: fixture.type } });
  }
  const seedOwner = await db.user.findFirstOrThrow({ where: { organizationId: org.id, username: 'suresh' } });
  const seedEmployees = await db.user.findMany({ where: { organizationId: org.id, role: 'EMPLOYEE' }, orderBy: { name: 'asc' } });
  const visitFixtures = [
    { key: 'received', name: 'Nisha Rao', mobile: '+919845612310', plate: 'KA05CD2714', make: 'Maruti', model: 'Baleno', type: 'HATCHBACK' as const, service: 'Basic Wash', status: 'RECEIVED' as const },
    { key: 'washing', name: 'Farhan Ali', mobile: '+919845612311', plate: 'TN09EF8421', make: 'Hyundai', model: 'Creta', type: 'SUV' as const, service: 'Premium Wash', status: 'WASHING' as const },
    { key: 'ready', name: 'Leena Das', mobile: '+919845612312', plate: 'MH02GH5639', make: 'Honda', model: 'City', type: 'SEDAN' as const, service: 'Interior Cleaning', status: 'READY' as const },
    { key: 'history', name: 'Dev Patel', mobile: '+919845612313', plate: 'GJ01JK8842', make: 'Tata', model: 'Nexon', type: 'SUV' as const, service: 'Premium Wash', status: 'HANDED_OVER' as const },
  ];
  for (const fixture of visitFixtures) {
    const customer = await db.customer.upsert({ where: { organizationId_mobile: { organizationId: org.id, mobile: fixture.mobile } }, update: {}, create: { organizationId: org.id, name: fixture.name, mobile: fixture.mobile } });
    const vehicle = await db.vehicle.upsert({ where: { organizationId_registrationNumber: { organizationId: org.id, registrationNumber: fixture.plate } }, update: {}, create: { organizationId: org.id, customerId: customer.id, registrationNumber: fixture.plate, make: fixture.make, model: fixture.model, type: fixture.type } });
    const service = await db.service.findUniqueOrThrow({ where: { organizationId_name: { organizationId: org.id, name: fixture.service } } });
    const idempotencyKey = `seed:visit:${fixture.key}`;
    if (await db.job.findUnique({ where: { organizationId_idempotencyKey: { organizationId: org.id, idempotencyKey } } })) continue;
    if (await db.job.findFirst({ where: { organizationId: org.id, vehicleId: vehicle.id, status: { not: 'HANDED_OVER' } } })) continue;
    const price = await db.servicePrice.findFirst({ where: { organizationId: org.id, serviceId: service.id, branchId: null, vehicleType: fixture.type } });
    const subtotalPaise = price?.pricePaise ?? service.basePricePaise;
    await db.$transaction(async (tx) => {
      const current = await tx.organization.update({ where: { id: org.id }, data: { nextJobNumber: { increment: 1 }, ...(fixture.status === 'HANDED_OVER' ? { nextInvoiceNumber: { increment: 1 } } : {}) } });
      const checkedInAt = new Date(Date.now() - (fixture.status === 'HANDED_OVER' ? 86_400_000 : 30 * 60_000));
      const expectedAt = new Date(checkedInAt.getTime() + service.estimatedMinutes * 60_000);
      const job = await tx.job.create({ data: {
        organizationId: org.id, branchId: branch.id, customerId: customer.id, vehicleId: vehicle.id, serviceId: service.id,
        number: current.nextJobNumber - 1, idempotencyKey, serviceName: service.name, subtotalPaise, taxPaise: 0, totalPaise: subtotalPaise,
        status: fixture.status, checkedInAt, stageAt: checkedInAt, checkedInById: seedOwner.id, expectedAt,
        handedOverAt: fixture.status === 'HANDED_OVER' ? new Date(checkedInAt.getTime() + 75 * 60_000) : undefined,
        handedOverById: fixture.status === 'HANDED_OVER' ? seedOwner.id : undefined,
        notify: false,
      } });
      const stages = ['RECEIVED', 'WASHING', 'READY', 'HANDED_OVER'] as const;
      for (let index = 0; index <= stages.indexOf(fixture.status); index++) {
        await tx.jobStageHistory.create({ data: { organizationId: org.id, jobId: job.id, fromStage: index ? stages[index - 1]! : undefined, toStage: stages[index]!, actorUserId: seedOwner.id, createdAt: new Date(checkedInAt.getTime() + index * 20 * 60_000) } });
      }
      const assignedEmployee = seedEmployees[0];
      if (assignedEmployee && fixture.status !== 'HANDED_OVER') {
        await tx.jobAssignment.create({ data: { organizationId: org.id, jobId: job.id, employeeId: assignedEmployee.id, assignedById: seedOwner.id } });
      }
      if (fixture.status === 'HANDED_OVER') {
        const invoice = await tx.invoice.create({ data: { organizationId: org.id, jobId: job.id, invoiceNumber: `${current.invoicePrefix}-${String(current.nextInvoiceNumber - 1).padStart(5, '0')}`, subtotalPaise, taxPaise: 0, totalPaise: subtotalPaise, status: 'PARTIALLY_PAID', issuedAt: job.handedOverAt! } });
        await tx.payment.create({ data: { organizationId: org.id, invoiceId: invoice.id, idempotencyKey: 'seed:payment:history', amountPaise: Math.floor(subtotalPaise / 2), method: 'UPI', collectedById: seedOwner.id, createdAt: job.handedOverAt! } });
      }
      await tx.auditLog.create({ data: { organizationId: org.id, actorUserId: seedOwner.id, action: 'SEED_JOB_CREATED', entityType: 'Job', entityId: job.id, after: { status: fixture.status, number: job.number } } });
    });
  }
  process.stdout.write('Local organization: sparkle\nOwner username: suresh\n');
  if (!owner || process.env.DEV_SEED_PASSWORD) process.stdout.write(`Local owner password: ${password}\n`);
  else process.stdout.write('Owner already existed; password unchanged. Set DEV_SEED_PASSWORD to reset locally.\n');
} finally { await db.$disconnect(); }
