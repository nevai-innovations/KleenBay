import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';

// Operator-only synthetic fixtures, streamed to a stage pod; never an HTTP admin bypass.
export async function createEntitlementFixtures() {
  const env = process.env;
  if (env.NODE_ENV !== 'production' || env.STAGING_MODE !== 'true' || env.POD_NAMESPACE !== 'kleenbay-stage' || env.EXPECTED_DATABASE_NAME !== 'kleenbay_stage' || env.APP_ORIGIN !== 'https://stage.kleenbay.com' || new URL(env.DATABASE_URL).pathname !== '/kleenbay_stage' || env.RAZORPAY_ENV !== 'test' || env.MESSAGING_PROVIDER !== 'mock') throw new Error('Synthetic fixture creation is restricted to KleenBay stage test mode');
  const require = createRequire('/app/apps/api/package.json');
  const { hash } = require('@node-rs/argon2');
  const { createDb } = await import('/app/apps/api/dist/db.js');
  const { audit } = await import('/app/apps/api/dist/audit.js');
  const db = createDb(env.DATABASE_URL);
  const fixtures = [];
  const run = randomUUID();
  const phoneBase = 9000000000 + randomInt(100000000);
  try {
    for (const [index, state] of ['ACTIVE', 'SOON', 'GRACE_PERIOD', 'EXPIRED', 'NOT_SUBSCRIBED'].entries()) {
      const slug = `entitlement-qa-${run}-${index}`;
      const password = randomBytes(24).toString('base64url');
      const email = `${slug}@example.invalid`;
      const now = new Date();
      const end = new Date(now.getTime() + 365 * 86400000);
      const organization = await db.organization.create({ data: { slug, name: `Synthetic Entitlement QA ${state}`, employeeHandover: true, allowOutstanding: true, sendHandoverMessage: true } });
      const organizationId = organization.id;
      const branch = await db.branch.create({ data: { organizationId, name: 'Synthetic Main' } });
      const owner = await db.user.create({ data: { organizationId, branchId: branch.id, role: 'OWNER', name: 'Synthetic Owner', email, passwordHash: await hash(password) } });
      await db.subscription.create({ data: { organizationId, status: 'ACTIVE', activatedAt: now, currentPeriodStart: now, currentPeriodEnd: end } });
      await audit(db, { organizationId, actorUserId: owner.id, action: 'STAGE_ENTITLEMENT_QA_FIXTURE_CREATED', entityType: 'Organization', entityId: organizationId, after: { synthetic: true, run, intendedState: state } });
      const request = async (path, body, cookie) => {
        const response = await fetch(`http://127.0.0.1:3000/api${path}`, { method: 'POST', headers: { origin: env.APP_ORIGIN, 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
        if (!response.ok) throw new Error(`Synthetic fixture API failed: ${path} ${response.status}`);
        return { body: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
      };
      const login = await request('/auth/owner/login', { login: email, password });
      const cookie = login.cookie;
      const mobile = String(phoneBase + index);
      const employee = await request('/employees', { name: 'Synthetic Employee', mobile, branchId: branch.id }, cookie);
      const service = await request('/services', { name: 'Synthetic Wash', category: 'Wash', basePricePaise: 120000, estimatedMinutes: 45 }, cookie);
      await request('/auth/employee/request-otp', { mobile });
      const employeeLogin = await request('/auth/employee/verify-otp', { mobile, code: env.DUMMY_OTP });
      let jobId = null;
      const checkIn = { idempotencyKey: randomUUID(), branchId: branch.id, mobile: '9876543200', customerName: 'Synthetic Customer', registrationNumber: `KA01QA${1200 + index}`, make: 'Tata', model: 'Nexon', vehicleType: 'SUV', serviceId: service.body.id, expectedAt: new Date(Date.now() + 3600000).toISOString(), notify: true };
      if (state !== 'NOT_SUBSCRIBED') jobId = (await request('/jobs/check-in', checkIn, cookie)).body.id;
      const periodEnd = new Date(now.getTime() + (state === 'GRACE_PERIOD' ? -1 : state === 'EXPIRED' ? -8 : state === 'SOON' ? 6 : 365) * 86400000);
      const periodStart = new Date(periodEnd.getTime() - 365 * 86400000);
      await db.$transaction(async (tx) => {
        if (jobId) await tx.job.update({ where: { id: jobId, organizationId }, data: { checkedInAt: new Date(Math.min(now.getTime() - 3600000, periodEnd.getTime() - 86400000)) } });
        await tx.subscription.update({ where: { organizationId }, data: state === 'NOT_SUBSCRIBED' ? { status: 'INACTIVE', activatedAt: null, currentPeriodStart: null, currentPeriodEnd: null } : { currentPeriodStart: periodStart, currentPeriodEnd: periodEnd } });
        await audit(tx, { organizationId, actorUserId: owner.id, action: 'STAGE_ENTITLEMENT_QA_DATES_SET', entityType: 'Organization', entityId: organizationId, after: { synthetic: true, run, state, currentPeriodStart: state === 'NOT_SUBSCRIBED' ? null : periodStart.toISOString(), currentPeriodEnd: state === 'NOT_SUBSCRIBED' ? null : periodEnd.toISOString() } });
      });
      fixtures.push({ state, organizationId, ownerId: owner.id, employeeId: employee.body.id, branchId: branch.id, email, password, cookie, employeeCookie: employeeLogin.cookie, checkIn, jobId, periodEnd: periodEnd.toISOString() });
    }
    // The caller must capture privately, never print this return value to logs or documentation.
    return { run, fixtures };
  } finally { await db.$disconnect(); }
}
