import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { batchSchema, type M2Service } from '../production/m2.js';
export async function registerM2(app: FastifyInstance, service: M2Service) {
  const id = (req: { params: unknown }) => z.object({ id: z.string().min(1).max(150) }).parse(req.params).id;
  app.get('/api/projects/:id/m2', async req => service.view(id(req)));
  app.post('/api/projects/:id/m2/frames', async req => service.frames(id(req), batchSchema.parse(req.body)));
  app.post('/api/projects/:id/m2/estimate-frames', async req => service.estimateFrames(id(req), z.object({ shotIds: batchSchema.shape.shotIds }).parse(req.body).shotIds));
  app.post('/api/projects/:id/m2/select', async req => { const value = z.object({ revision: batchSchema.shape.revision, shotId: z.string().min(1).max(80), entryId: z.string().min(1).max(300) }).parse(req.body); return service.select(id(req), value.revision, value.shotId, value.entryId); });
  app.post('/api/projects/:id/m2/approve', async req => { const value = z.object({ revision: batchSchema.shape.revision, manifestHash: z.string().regex(/^[a-f0-9]{64}$/) }).parse(req.body); return service.approve(id(req), value.revision, value.manifestHash); });
}
