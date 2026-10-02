import type { FastifyInstance } from 'fastify';
import { normalizeIndianMobile, otpRequestSchema, otpVerifySchema } from '@carwash/shared';
import type { Config } from './config.js';
import type { Db } from './db.js';
import { audit } from './audit.js';
import { startSession } from './auth.js';
import { HttpError } from './errors.js';
import { createChallengeSecret, hashOtp, matchesOtp, type OtpProvider } from './otp.js';

const invalidOtp = () => new HttpError(401, 'INVALID_OTP', 'Invalid or expired code');
const transactionOptions = { maxWait: 10_000, timeout: 10_000 };

async function lockKeys(tx: Parameters<Parameters<Db['$transaction']>[0]>[0], keys: string[]) {
  for (const key of [...new Set(keys)].sort()) {
    await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
  }
}

export function registerEmployeeOtpRoutes(app: FastifyInstance, config: Config, db: Db, otp: OtpProvider) {
  const findEmployee = async (mobile: string, orgSlug?: string) => {
    const matches = await db.employeeProfile.findMany({ where: { mobile }, include: { user: true }, take: 2 });
    const employee = matches.length === 1 ? matches[0] : orgSlug
      ? await db.employeeProfile.findFirst({ where: { mobile, user: { organization: { slug: orgSlug } } }, include: { user: true } })
      : null;
    return employee?.user.active && employee.user.role === 'EMPLOYEE' ? employee : null;
  };
  app.get('/api/auth/employee/otp-config', async () => ({
    provider: config.otpMode,
    otpLength: config.otpMode === 'msg91' ? config.MSG91_WIDGET_OTP_LENGTH : 6,
    ...(config.otpMode === 'msg91' ? { widgetId: config.MSG91_WIDGET_ID, widgetToken: config.MSG91_WIDGET_TOKEN } : {}),
  }));

  app.post('/api/auth/employee/request-otp', { config: { rateLimit: { max: 12, timeWindow: '15 minutes' } } }, async (request) => {
    const input = otpRequestSchema.parse(request.body);
    const employee = await findEmployee(input.mobile, typeof request.headers['x-organization-slug'] === 'string' ? request.headers['x-organization-slug'] : undefined);
    if (!employee) throw new HttpError(404, 'EMPLOYEE_NOT_FOUND', 'No active employee account for this mobile number');
    const org = await db.organization.findUniqueOrThrow({ where: { id: employee.organizationId } });
    if (config.otpMode === 'unconfigured') throw new HttpError(503, 'OTP_UNAVAILABLE', 'Employee OTP is not configured');
    const sourceHash = hashOtp(`source:${request.ip}`, config.OTP_HASH_SECRET);
    const now = new Date();
    const secret = config.dummyOtp ? config.DUMMY_OTP! : config.devOtp ? config.DEV_OTP_FIXED_CODE! : createChallengeSecret();
    await db.$transaction(async (tx) => {
      await lockKeys(tx, [`otp:phone:${employee.userId}`, `otp:source:${sourceHash}`]);
      const recent = await tx.otpChallenge.findFirst({ where: { userId: employee.userId }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
      if (recent && recent.createdAt > new Date(now.getTime() - config.OTP_RESEND_SECONDS * 1000)) throw new HttpError(429, 'OTP_RATE_LIMIT', 'Wait before requesting another code');
      const windowStart = new Date(now.getTime() - config.OTP_RATE_LIMIT_WINDOW_MINUTES * 60_000);
      const [phoneCount, sourceCount] = await Promise.all([
        tx.otpChallenge.count({ where: { userId: employee.userId, createdAt: { gte: windowStart } } }),
        tx.otpChallenge.count({ where: { requestSourceHash: sourceHash, createdAt: { gte: windowStart } } }),
      ]);
      if (phoneCount >= config.OTP_MAX_REQUESTS_PER_PHONE_WINDOW || sourceCount >= config.OTP_MAX_REQUESTS_PER_SOURCE_WINDOW) throw new HttpError(429, 'OTP_RATE_LIMIT', 'Too many code requests');
      await tx.otpChallenge.updateMany({ where: { userId: employee.userId, consumedAt: null }, data: { consumedAt: now } });
      await tx.otpChallenge.create({ data: {
        organizationId: org.id, userId: employee.userId, requestSourceHash: sourceHash,
        codeHash: hashOtp(`${input.mobile}:${secret}`, config.OTP_HASH_SECRET), maxAttempts: config.OTP_MAX_ATTEMPTS,
        expiresAt: new Date(now.getTime() + config.OTP_TTL_MINUTES * 60_000),
      } });
      await audit(tx, { organizationId: org.id, actorUserId: employee.userId, action: 'OTP_REQUESTED', entityType: 'User', entityId: employee.userId, ipAddress: request.ip });
    }, transactionOptions);
    return { status: 'sent', provider: config.otpMode, otpLength: config.otpMode === 'msg91' ? config.MSG91_WIDGET_OTP_LENGTH : 6, expiresInSeconds: config.OTP_TTL_MINUTES * 60, resendAfterSeconds: config.OTP_RESEND_SECONDS };
  });

  app.post('/api/auth/employee/verify-otp', { config: { rateLimit: { max: 10, timeWindow: '10 minutes' } } }, async (request, reply) => {
    const input = otpVerifySchema.parse(request.body);
    const usesMsg91 = config.otpMode === 'msg91';
    if (usesMsg91 !== ('accessToken' in input) || (!usesMsg91 && !config.devOtp && !config.dummyOtp)) throw new HttpError(400, 'OTP_METHOD_MISMATCH', 'OTP verification method is unavailable');
    const employee = await findEmployee(input.mobile, typeof request.headers['x-organization-slug'] === 'string' ? request.headers['x-organization-slug'] : undefined);
    if (!employee) throw invalidOtp();
    const org = await db.organization.findUniqueOrThrow({ where: { id: employee.organizationId } });
    let verifiedMobile: string | null = null;
    let tokenHash: string | undefined;
    if ('accessToken' in input) {
      try {
        verifiedMobile = normalizeIndianMobile(await otp.verifyAccessToken(input.accessToken));
      } catch (error) {
        if (error instanceof HttpError && error.statusCode === 503) throw error;
        verifiedMobile = null;
      }
      tokenHash = hashOtp(`msg91-widget:${input.accessToken}`, config.OTP_HASH_SECRET);
    }
    const outcome = await db.$transaction(async (tx) => {
      await lockKeys(tx, [`otp:phone:${employee.userId}`, ...(tokenHash ? [`otp:provider-token:${tokenHash}`] : [])]);
      const challenge = await tx.otpChallenge.findFirst({ where: { userId: employee.userId }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
      if (!challenge || challenge.expiresAt <= new Date() || challenge.consumedAt) return false;
      if (challenge.attempts >= challenge.maxAttempts) return false;
      const valid = 'accessToken' in input
        ? verifiedMobile === input.mobile && !(await tx.otpChallenge.findUnique({ where: { providerTokenHash: tokenHash! } }))
        : matchesOtp(challenge.codeHash, hashOtp(`${input.mobile}:${input.code}`, config.OTP_HASH_SECRET));
      if (!valid) {
        await tx.otpChallenge.update({ where: { id: challenge.id }, data: { attempts: { increment: 1 } } });
        return false;
      }
      const consumed = await tx.otpChallenge.updateMany({ where: { id: challenge.id, consumedAt: null }, data: { consumedAt: new Date(), ...(tokenHash ? { providerTokenHash: tokenHash } : {}) } });
      if (consumed.count !== 1) return false;
      const active = await tx.user.findFirst({ where: { id: employee.userId, organizationId: org.id, active: true, role: 'EMPLOYEE' } });
      if (!active) return false;
      await tx.user.update({ where: { id: active.id }, data: { lastLoginAt: new Date() } });
      await audit(tx, { organizationId: org.id, actorUserId: active.id, action: 'EMPLOYEE_LOGIN', entityType: 'User', entityId: active.id, ipAddress: request.ip });
      return true;
    }, transactionOptions);
    if (!outcome) throw invalidOtp();
    await startSession(db, reply, config, employee.user);
    return { user: { id: employee.user.id, role: 'EMPLOYEE', name: employee.user.name, organizationId: org.id, branchId: employee.user.branchId }, organization: { id: org.id, name: org.name } };
  });
}
