import { hash } from '@node-rs/argon2';
import { z } from 'zod';
import { audit } from '../audit.js';
import { getConfig } from '../config.js';
import { createDb } from '../db.js';

const config = getConfig();
if (!config.stagingMode) throw new Error('Stage bootstrap requires STAGING_MODE=true');

const input = z
  .object({
    STAGE_ORGANIZATION_NAME: z.string().min(2),
    STAGE_ORGANIZATION_SLUG: z.string().regex(/^[a-z0-9-]+$/),
    STAGE_BRANCH_NAME: z.string().min(2),
    STAGE_OWNER_NAME: z.string().min(2),
    STAGE_OWNER_USERNAME: z.string().min(3),
    STAGE_OWNER_EMAIL: z.email(),
    STAGE_OWNER_PASSWORD: z.string().min(16),
  })
  .parse(process.env);

const db = createDb(config.DATABASE_URL);
try {
  await db.$transaction(async (tx) => {
    if (await tx.organization.findUnique({ where: { slug: input.STAGE_ORGANIZATION_SLUG } })) {
      throw new Error('Stage organization already exists; bootstrap will not overwrite it');
    }
    const organization = await tx.organization.create({
      data: { name: input.STAGE_ORGANIZATION_NAME, slug: input.STAGE_ORGANIZATION_SLUG },
    });
    const branch = await tx.branch.create({
      data: { organizationId: organization.id, name: input.STAGE_BRANCH_NAME },
    });
    const owner = await tx.user.create({
      data: {
        organizationId: organization.id,
        branchId: branch.id,
        role: 'OWNER',
        name: input.STAGE_OWNER_NAME,
        username: input.STAGE_OWNER_USERNAME.toLowerCase(),
        email: input.STAGE_OWNER_EMAIL.toLowerCase(),
        passwordHash: await hash(input.STAGE_OWNER_PASSWORD),
      },
    });
    await audit(tx, {
      organizationId: organization.id,
      actorUserId: owner.id,
      action: 'STAGE_BOOTSTRAP',
      entityType: 'Organization',
      entityId: organization.id,
    });
  });
  process.stdout.write('Stage organization and owner created.\n');
} finally {
  await db.$disconnect();
}
