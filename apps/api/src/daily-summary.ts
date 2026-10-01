import type { FastifyInstance } from 'fastify';
import { dailySummaryQuerySchema, paymentMethods, type DailySummary } from '@carwash/shared';
import type { Db } from './db.js';
import { requireOwner } from './auth.js';
import { notFound } from './errors.js';

type ZonedParts = { year: number; month: number; day: number; hour: number; minute: number; second: number };

function zonedParts(date: Date, timeZone: string): ZonedParts {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  });
  const parts = Object.fromEntries(formatter.formatToParts(date).filter((part) => part.type !== 'literal').map((part) => [part.type, Number(part.value)]));
  return parts as ZonedParts;
}

function midnightUtc(year: number, month: number, day: number, timeZone: string): Date {
  const localMidnight = Date.UTC(year, month - 1, day);
  let guess = localMidnight;
  // Resolve the zone offset at the date being reported, including DST changes.
  for (let attempt = 0; attempt < 3; attempt++) {
    const actual = zonedParts(new Date(guess), timeZone);
    const localAtGuess = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute, actual.second);
    guess += localMidnight - localAtGuess;
  }
  return new Date(guess);
}

export function todayWindow(now: Date, timeZone: string) {
  const { year, month, day } = zonedParts(now, timeZone);
  const next = new Date(Date.UTC(year, month - 1, day + 1));
  return {
    date: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
    start: midnightUtc(year, month, day, timeZone),
    end: midnightUtc(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), timeZone),
  };
}

export function registerDailySummaryRoutes(app: FastifyInstance, db: Db) {
  app.get('/api/summary/daily', async (request): Promise<DailySummary> => {
    const owner = await requireOwner(db, request);
    const { branchId } = dailySummaryQuerySchema.parse(request.query);
    if (branchId && !await db.branch.findFirst({ where: { id: branchId, organizationId: owner.organizationId } })) notFound();
    const organization = await db.organization.findUniqueOrThrow({ where: { id: owner.organizationId }, select: { timezone: true } });
    const now = new Date();
    const { date, start, end } = todayWindow(now, organization.timezone);
    const scope = { organizationId: owner.organizationId, ...(branchId ? { branchId } : {}) };
    const invoiceBranch = branchId ? { job: { branchId } } : {};
    const paymentBranch = branchId ? { invoice: { job: { branchId } } } : {};

    const [received, handedOver, active, payments, invoices, stageUpdates] = await Promise.all([
      db.job.findMany({ where: { ...scope, checkedInAt: { gte: start, lt: end } }, select: { id: true, customerId: true, serviceName: true, totalPaise: true, status: true, checkedInAt: true } }),
      db.job.findMany({ where: { ...scope, handedOverAt: { gte: start, lt: end } }, select: { id: true, checkedInAt: true, handedOverAt: true, expectedAt: true } }),
      db.job.findMany({ where: { ...scope, status: { not: 'HANDED_OVER' } }, select: { id: true, status: true, expectedAt: true, stageAt: true, vehicle: { select: { registrationNumber: true } }, customer: { select: { name: true } } } }),
      db.payment.findMany({ where: { organizationId: owner.organizationId, createdAt: { gte: start, lt: end }, ...paymentBranch }, select: { amountPaise: true, method: true } }),
      db.invoice.findMany({ where: { organizationId: owner.organizationId, issuedAt: { gte: start, lt: end }, ...invoiceBranch }, select: { jobId: true, totalPaise: true, payments: { select: { amountPaise: true } }, job: { select: { vehicle: { select: { registrationNumber: true } }, customer: { select: { name: true } } } } } }),
      db.jobStageHistory.findMany({ where: { organizationId: owner.organizationId, createdAt: { gte: start, lt: end }, actor: { role: 'EMPLOYEE' }, ...(branchId ? { job: { branchId } } : {}) }, select: { jobId: true, toStage: true, actor: { select: { id: true, name: true } } } }),
    ]);

    const readyStages = handedOver.length ? await db.jobStageHistory.findMany({ where: { organizationId: owner.organizationId, jobId: { in: handedOver.map((job) => job.id) }, toStage: 'READY' }, select: { jobId: true, createdAt: true }, orderBy: { createdAt: 'desc' } }) : [];
    const readyAt = new Map<string, Date>();
    for (const stage of readyStages) if (!readyAt.has(stage.jobId)) readyAt.set(stage.jobId, stage.createdAt);

    const customerIds = [...new Set(received.map((job) => job.customerId))];
    const previous = customerIds.length ? await db.job.findMany({ where: { organizationId: owner.organizationId, customerId: { in: customerIds }, checkedInAt: { lt: start } }, distinct: ['customerId'], select: { customerId: true } }) : [];
    const returningIds = new Set(previous.map((job) => job.customerId));

    const methodTotals = new Map(paymentMethods.map((method) => [method, 0]));
    for (const payment of payments) methodTotals.set(payment.method, (methodTotals.get(payment.method) ?? 0) + payment.amountPaise);
    const serviceTotals = new Map<string, { name: string; count: number; valuePaise: number }>();
    const hourTotals = new Map<number, number>();
    for (const job of received) {
      const service = serviceTotals.get(job.serviceName) ?? { name: job.serviceName, count: 0, valuePaise: 0 };
      service.count++; service.valuePaise += job.totalPaise;
      serviceTotals.set(job.serviceName, service);
      const hour = zonedParts(job.checkedInAt, organization.timezone).hour;
      hourTotals.set(hour, (hourTotals.get(hour) ?? 0) + 1);
    }
    const occupiedHours = [...hourTotals.keys()].sort((a, b) => a - b);
    const hours = occupiedHours.length ? Array.from({ length: occupiedHours.at(-1)! - occupiedHours[0]! + 1 }, (_, index) => {
      const hour = occupiedHours[0]! + index;
      return { hour, count: hourTotals.get(hour) ?? 0 };
    }) : [];
    const busiestHour = hours.reduce<number | null>((best, row) => best === null || row.count > (hourTotals.get(best) ?? 0) ? row.hour : best, null);

    const staffMap = new Map<string, { id: string; name: string; jobIds: Set<string>; updates: number; handovers: number }>();
    for (const update of stageUpdates) {
      const staff = staffMap.get(update.actor.id) ?? { id: update.actor.id, name: update.actor.name, jobIds: new Set<string>(), updates: 0, handovers: 0 };
      staff.jobIds.add(update.jobId); staff.updates++;
      if (update.toStage === 'HANDED_OVER') staff.handovers++;
      staffMap.set(update.actor.id, staff);
    }

    const attention: DailySummary['attention'] = [];
    for (const job of active) {
      if (job.expectedAt < now) attention.push({ kind: 'LATE', jobId: job.id, registrationNumber: job.vehicle.registrationNumber, customerName: job.customer.name, detail: 'Past expected completion' });
      if (job.status === 'READY' && now.getTime() - job.stageAt.getTime() > 15 * 60_000) attention.push({ kind: 'READY_WAITING', jobId: job.id, registrationNumber: job.vehicle.registrationNumber, customerName: job.customer.name, detail: 'Ready, awaiting pickup' });
    }
    let unpaidPaise = 0;
    let unpaidInvoiceCount = 0;
    for (const invoice of invoices) {
      const outstanding = Math.max(0, invoice.totalPaise - invoice.payments.reduce((sum, payment) => sum + payment.amountPaise, 0));
      if (!outstanding) continue;
      unpaidPaise += outstanding; unpaidInvoiceCount++;
      attention.push({ kind: 'UNPAID', jobId: invoice.jobId, registrationNumber: invoice.job.vehicle.registrationNumber, customerName: invoice.job.customer.name, detail: 'Invoice outstanding', amountPaise: outstanding });
    }

    const turnaroundMinutes = handedOver.map((job) => (job.handedOverAt!.getTime() - job.checkedInAt.getTime()) / 60_000);
    const activeLate = active.filter((job) => job.expectedAt < now).length;
    const finishedLate = handedOver.filter((job) => (readyAt.get(job.id) ?? job.handedOverAt!) > job.expectedAt).length;
    return {
      date, timeZone: organization.timezone, asOf: now.toISOString(), branchId: branchId ?? null,
      receivedCount: received.length, handedOverCount: handedOver.length,
      stillOnBoardCount: received.filter((job) => job.status !== 'HANDED_OVER').length,
      collectedPaise: payments.reduce((sum, payment) => sum + payment.amountPaise, 0),
      collectionByMethod: paymentMethods.map((method) => ({ method, amountPaise: methodTotals.get(method) ?? 0 })).filter((row) => row.amountPaise > 0),
      unpaidPaise, unpaidInvoiceCount,
      pipelinePaise: received.filter((job) => job.status !== 'HANDED_OVER').reduce((sum, job) => sum + job.totalPaise, 0),
      avgTurnaroundMinutes: turnaroundMinutes.length ? Math.round(turnaroundMinutes.reduce((sum, minutes) => sum + minutes, 0) / turnaroundMinutes.length) : null,
      lateCount: activeLate + finishedLate,
      services: [...serviceTotals.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
      hours, busiestHour,
      staff: [...staffMap.values()].map((member) => ({ id: member.id, name: member.name, cars: member.jobIds.size, updates: member.updates, handovers: member.handovers })).sort((a, b) => b.cars - a.cars || a.name.localeCompare(b.name)),
      customers: { newCount: customerIds.length - returningIds.size, returningCount: returningIds.size },
      attention,
    };
  });
}
