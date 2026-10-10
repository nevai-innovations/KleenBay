import type { Db } from '../src/db.js';
import type { Prisma } from '../src/generated/prisma/client.js';

// Explicit paid fixture for pre-existing operational tests; never used by application code.
export async function activateTestOrganization(db: Db, organizationId: string) {
  const start = new Date();
  const end = new Date(start);
  end.setUTCFullYear(end.getUTCFullYear() + 1);
  await db.subscription.create({ data: { organizationId, status: 'ACTIVE', activatedAt: start, currentPeriodStart: start, currentPeriodEnd: end } });
}

export async function createPaidTestOrganization(db: Db, args: Prisma.OrganizationCreateArgs) {
  const organization = await db.organization.create(args);
  await activateTestOrganization(db, organization.id);
  return organization;
}
