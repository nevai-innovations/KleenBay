import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { inspectionSchema, photoKinds } from '@carwash/shared';
import type { Db } from './db.js';
import { audit } from './audit.js';
import { currentUser } from './auth.js';
import { HttpError, notFound } from './errors.js';
import { imageType, type StorageProvider } from './storage.js';

const jobParams = z.object({ id: z.string().min(1) });
const photoQuery = z.object({ kind: z.enum(photoKinds), description: z.string().trim().max(500).optional(), damageItemId: z.string().optional() });

export function registerMediaRoutes(app: FastifyInstance, db: Db, storage: StorageProvider) {
  app.post('/api/jobs/:id/inspection', async (request, reply) => {
    const user = await currentUser(db, request);
    const { id } = jobParams.parse(request.params);
    const input = inspectionSchema.parse(request.body);
    const job = await db.job.findFirst({ where: { id, organizationId: user.organizationId, ...(user.role === 'EMPLOYEE' && user.branchId ? { branchId: user.branchId } : {}) } });
    if (!job) notFound();
    if (job.status === 'HANDED_OVER') throw new HttpError(409, 'JOB_CLOSED', 'Condition records cannot be added after Handover');
    const existing = await db.vehicleInspection.findUnique({ where: { jobId: id } });
    if (existing) throw new HttpError(409, 'INSPECTION_FINALIZED', 'This condition record is finalized');
    const inspection = await db.$transaction(async (tx) => {
      const record = await tx.vehicleInspection.create({ data: { organizationId: user.organizationId, jobId: id, recordedById: user.id } });
      if (input.damages.length) await tx.inspectionDamageItem.createMany({ data: input.damages.map((damage) => ({ organizationId: user.organizationId, inspectionId: record.id, ...damage })) });
      const created = await tx.vehicleInspection.findUniqueOrThrow({ where: { id: record.id }, include: { damages: true } });
      await audit(tx, { organizationId: user.organizationId, actorUserId: user.id, action: 'INSPECTION_FINALIZED', entityType: 'VehicleInspection', entityId: created.id, after: { jobId: id, damages: input.damages }, ipAddress: request.ip });
      return created;
    });
    return reply.code(201).send(inspection);
  });

  app.post('/api/jobs/:id/photos', async (request, reply) => {
    const user = await currentUser(db, request);
    const { id } = jobParams.parse(request.params);
    const input = photoQuery.parse(request.query);
    const job = await db.job.findFirst({ where: { id, organizationId: user.organizationId, ...(user.role === 'EMPLOYEE' && user.branchId ? { branchId: user.branchId } : {}) } });
    if (!job) notFound();
    if (job.status === 'HANDED_OVER') throw new HttpError(409, 'JOB_CLOSED', 'Photos cannot be added after Handover');
    if (input.damageItemId) {
      const item = await db.inspectionDamageItem.findFirst({ where: { id: input.damageItemId, organizationId: user.organizationId, inspection: { jobId: id } } });
      if (!item || input.kind !== 'DAMAGE') throw new HttpError(400, 'INVALID_DAMAGE_ITEM', 'Choose a damage item on this job');
    }
    const file = await request.file({ limits: { files: 1, fileSize: 8 * 1024 * 1024 } });
    if (!file) throw new HttpError(400, 'FILE_REQUIRED', 'Choose a photo');
    const data = await file.toBuffer();
    const type = imageType(data);
    if (!type || type.mimeType !== file.mimetype) throw new HttpError(415, 'INVALID_IMAGE', 'Upload a JPEG, PNG or WebP image');
    const key = await storage.put({ organizationId: user.organizationId, jobId: id, extension: type.extension, data });
    try {
      const photo = await db.$transaction(async (tx) => {
        const created = await tx.photo.create({ data: { organizationId: user.organizationId, jobId: id, damageItemId: input.damageItemId, kind: input.kind, storageKey: key, mimeType: type.mimeType, byteSize: data.length, description: input.description, uploadedById: user.id } });
        await audit(tx, { organizationId: user.organizationId, actorUserId: user.id, action: 'PHOTO_UPLOADED', entityType: 'Photo', entityId: created.id, after: { jobId: id, kind: input.kind, byteSize: data.length }, ipAddress: request.ip });
        return created;
      });
      return reply.code(201).send({ id: photo.id, kind: photo.kind, description: photo.description, createdAt: photo.createdAt, url: `/api/photos/${photo.id}` });
    } catch (error) {
      await storage.remove(key);
      throw error;
    }
  });

  app.get('/api/photos/:id', async (request, reply) => {
    const user = await currentUser(db, request);
    const { id } = jobParams.parse(request.params);
    const photo = await db.photo.findFirst({ where: { id, organizationId: user.organizationId, ...(user.role === 'EMPLOYEE' && user.branchId ? { job: { branchId: user.branchId } } : {}) } });
    if (!photo) notFound();
    return reply.header('Cache-Control', 'private, max-age=300').header('X-Content-Type-Options', 'nosniff').type(photo.mimeType).send(await storage.get(photo.storageKey));
  });
}
