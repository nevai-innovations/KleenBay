import { createDb } from '../db.js';
import { audit } from '../audit.js';
import { assertDatabaseTarget } from '../database-target.js';

const targets = [
  { email: 'anandalekshmi@nevaitech.com', slug: 'anandalekshmi-stage', name: 'Anandalekshmi Test Car Wash' },
  { email: 'aswin@nevaitech.com', slug: 'aswin-stage', name: 'Aswin Test Car Wash' },
  { email: 'praveena.p@nevaitech.com', slug: 'praveena-stage', name: 'Praveena Test Car Wash' },
] as const;

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url || process.env.NODE_ENV !== 'production' || process.env.STAGING_MODE !== 'true' || process.env.EXPECTED_DATABASE_NAME !== 'kleenbay_stage') throw new Error('This transfer is restricted to KleenBay stage');
  assertDatabaseTarget(url, 'kleenbay_stage', true);
  if (!new URL(url).hostname.startsWith('brickview-postgres-stage.')) throw new Error('Unexpected database host for stage transfer');
  const db = createDb(url);
  try {
    const result = await db.$transaction(async (tx) => {
      const source = await tx.organization.findUniqueOrThrow({ where: { slug: 'sparkle' } });
      const owners = await tx.user.findMany({ where: { role: 'OWNER', email: { in: ['arun@kleenbay.com', ...targets.map((target) => target.email)] } } });
      if (owners.length !== 4 || !owners.every((owner) => owner.active && owner.passwordHash)) throw new Error('Expected four active owners with existing password hashes');
      const arun = owners.find((owner) => owner.email === 'arun@kleenbay.com');
      if (!arun || arun.organizationId !== source.id) throw new Error('Arun must remain in the existing organization');
      const alreadySplit = await Promise.all(targets.map(async (target) => {
        const owner = owners.find((candidate) => candidate.email === target.email);
        const org = await tx.organization.findUnique({ where: { slug: target.slug } });
        return !!owner && !!org && owner.organizationId === org.id;
      }));
      if (alreadySplit.every(Boolean)) return { moved: 0, alreadySplit: true };
      if (alreadySplit.some(Boolean)) throw new Error('Partial owner transfer found; manual review required');
      if (await tx.user.count({ where: { organizationId: source.id, role: 'OWNER' } }) !== 4) throw new Error('Unexpected source owner count');

      const moving = targets.map((target) => {
        const owner = owners.find((candidate) => candidate.email === target.email);
        if (!owner || owner.organizationId !== source.id || owner.branchId) throw new Error(`Unexpected owner mapping for ${target.email}`);
        return { target, owner };
      });
      for (const { target, owner } of moving) {
        if (await tx.organization.findUnique({ where: { slug: target.slug } })) throw new Error(`Target organization already exists: ${target.slug}`);
        const [checkedIn, handedOver, stages, assignments, payments, inspections, photos, challenges, setups] = await Promise.all([
          tx.job.count({ where: { checkedInById: owner.id } }),
          tx.job.count({ where: { handedOverById: owner.id } }),
          tx.jobStageHistory.count({ where: { actorUserId: owner.id } }),
          tx.jobAssignment.count({ where: { OR: [{ employeeId: owner.id }, { assignedById: owner.id }] } }),
          tx.payment.count({ where: { collectedById: owner.id } }),
          tx.vehicleInspection.count({ where: { recordedById: owner.id } }),
          tx.photo.count({ where: { uploadedById: owner.id } }),
          tx.otpChallenge.count({ where: { userId: owner.id } }),
          tx.ownerSetup.count({ where: { userId: owner.id } }),
        ]);
        if ([checkedIn, handedOver, stages, assignments, payments, inspections, photos, challenges, setups].some(Boolean)) throw new Error(`Owner ${target.email} has linked business records; review ownership before transfer`);
      }

      await tx.$executeRawUnsafe('SET CONSTRAINTS "Session_userId_organizationId_fkey", "AuditLog_actorUserId_organizationId_fkey" DEFERRED');
      for (const { target, owner } of moving) {
        const org = await tx.organization.create({ data: { slug: target.slug, name: target.name } });
        await tx.branch.create({ data: { organizationId: org.id, name: 'Main' } });
        await tx.user.update({ where: { id: owner.id }, data: { organizationId: org.id } });
        await tx.session.updateMany({ where: { userId: owner.id, organizationId: source.id }, data: { organizationId: org.id } });
        await tx.auditLog.updateMany({ where: { actorUserId: owner.id, organizationId: source.id }, data: { organizationId: org.id } });
        await audit(tx, { organizationId: org.id, actorUserId: owner.id, action: 'OWNER_TENANT_SEPARATED', entityType: 'Organization', entityId: org.id, after: { sourceOrganizationId: source.id } });
      }
      return { moved: moving.length, alreadySplit: false };
    }, { timeout: 60_000 });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    await db.$disconnect();
  }
}

main().catch((error: unknown) => { process.stderr.write(`${error instanceof Error ? error.message : 'Transfer failed'}\n`); process.exitCode = 1; });
