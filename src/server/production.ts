import type { FastifyInstance } from 'fastify';
import { basename, dirname } from 'node:path';
import { z } from 'zod';
import { ProductionService, publicEntry } from '../production/service.js';

export async function registerProduction(app: FastifyInstance, service: ProductionService) {
  const ids = z.object({ id: z.string().min(1).max(150), entryId: z.string().min(1).max(300).optional() });
  app.get('/api/projects/:id/production', async req => service.list(ids.parse(req.params).id));
  app.get('/api/projects/:id/production/:entryId/record', async (req, reply) => { const { id, entryId } = ids.parse(req.params); return reply.header('Content-Disposition', 'attachment; filename="production-record.json"').send(publicEntry(service.repo.production.get(id, entryId!))); });
  app.get('/api/projects/:id/production/:entryId/prompt', async (req, reply) => { const { id, entryId } = ids.parse(req.params); const entry = service.repo.production.get(id, entryId!); return reply.type('text/plain; charset=utf-8').header('Content-Disposition', 'attachment; filename="prompt.txt"').send(entry.prompt ?? '该记录未保存 Prompt'); });
  app.get('/api/projects/:id/production/export', async (req, reply) => {
    const id = ids.parse(req.params).id; const archive = await service.export(id);
    return reply.type('application/zip').header('Cache-Control', 'no-store').header('Content-Disposition', `attachment; filename="project-${id.replace(/[^\w-]/g, '')}.zip"; filename*=UTF-8''${encodeURIComponent(archive.title + '-生产库.zip')}`).send(archive.stream);
  });
  app.get('/api/projects/:id/production/:entryId/file', async (req, reply) => {
    const { id, entryId } = ids.parse(req.params); const file = await service.file(id, entryId!);
    const mime = file.entry.file!.mime;
    if (!['image/png', 'image/jpeg', 'image/webp', 'video/mp4'].includes(mime) || (req.query as { download?: string }).download === '1') reply.header('Content-Disposition', 'attachment');
    return reply.header('Cache-Control', 'private, no-store').type(mime).sendFile(basename(file.path), dirname(file.path));
  });
}
