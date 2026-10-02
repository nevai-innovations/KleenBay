import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { Db } from './db.js';
import type { Config } from './config.js';
import type { StorageProvider } from './storage.js';
import { HttpError, notFound } from './errors.js';
import { trackingHash } from './tracking.js';

const tokenPattern = /^[A-Za-z0-9_-]{43}$/;
const paramsSchema = z.object({ token: z.string(), ordinal: z.string().optional() });

function privateResponse(reply: FastifyReply) {
  return reply.header('Cache-Control', 'no-store').header('Referrer-Policy', 'no-referrer').header('X-Robots-Tag', 'noindex, nofollow').header('X-Content-Type-Options', 'nosniff');
}

export function registerPublicTrackingRoutes(app: FastifyInstance, db: Db, storage: StorageProvider, config: Config) {
  async function resolveJob(token: string) {
    if (!tokenPattern.test(token)) notFound();
    const job = await db.job.findUnique({
      where: { trackingTokenHash: trackingHash(token) },
      select: {
        organizationId: true, status: true, serviceName: true, expectedAt: true, checkedInAt: true, handedOverAt: true,
        organization: { select: { name: true, showCustomerTrackingLink: true, showCompletedVehiclePhotos: true } },
        vehicle: { select: { registrationNumber: true, make: true, model: true } },
        stages: { where: { toStage: { in: ['WASHING', 'READY'] } }, select: { toStage: true, createdAt: true }, orderBy: { createdAt: 'asc' } },
        photos: { where: { kind: 'AFTER', customerVisible: true }, select: { storageKey: true, mimeType: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] },
      },
    });
    if (!job || !job.organization.showCustomerTrackingLink) notFound();
    if (job.handedOverAt && Date.now() >= job.handedOverAt.getTime() + config.TRACKING_EXPIRY_DAYS * 86_400_000) {
      throw new HttpError(410, 'TRACKING_EXPIRED', 'This tracking link has expired.');
    }
    return job;
  }

  async function detail(token: string, reply: FastifyReply) {
    privateResponse(reply);
    const job = await resolveJob(token);
    return {
      businessName: job.organization.name,
      businessLogoUrl: null,
      vehicleRegistration: job.vehicle.registrationNumber,
      vehicleMake: job.vehicle.make,
      vehicleModel: job.vehicle.model,
      serviceName: job.serviceName,
      status: job.status,
      expectedCompletionAt: job.expectedAt,
      receivedAt: job.checkedInAt,
      washingStartedAt: job.stages.find((stage) => stage.toStage === 'WASHING')?.createdAt ?? null,
      readyAt: job.stages.find((stage) => stage.toStage === 'READY')?.createdAt ?? null,
      handedOverAt: job.handedOverAt,
      photos: job.organization.showCompletedVehiclePhotos ? job.photos.map((_, index) => ({ url: `/api/public/tracking/${token}/photos/${index + 1}` })) : [],
    };
  }

  app.get('/api/public/tracking/:token', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (request, reply) => {
    const { token } = paramsSchema.parse(request.params);
    return detail(token, reply);
  });

  // Preserve links sent before the public endpoint was renamed.
  app.get('/api/public/track/:token', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (request, reply) => {
    const { token } = paramsSchema.parse(request.params);
    const current = await detail(token, reply);
    return { businessName: current.businessName, vehicleNumber: current.vehicleRegistration, serviceName: current.serviceName, status: current.status, expectedAt: current.expectedCompletionAt, handedOverAt: current.handedOverAt };
  });

  app.get('/api/public/tracking/:token/photos/:ordinal', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (request, reply) => {
    privateResponse(reply);
    const { token, ordinal } = paramsSchema.parse(request.params);
    if (!ordinal || !/^[1-9]\d{0,2}$/.test(ordinal)) notFound();
    const job = await resolveJob(token);
    if (!job.organization.showCompletedVehiclePhotos) notFound();
    const photo = job.photos[Number(ordinal) - 1];
    if (!photo) notFound();
    return reply.type(photo.mimeType).send(await storage.get(photo.storageKey));
  });
}
