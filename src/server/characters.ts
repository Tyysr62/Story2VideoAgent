import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { CharacterService } from '../characters/service.js';
import { MAX_PORTRAIT_BYTES } from '../characters/images.js';
import { characterInputSchema, characterPatchSchema, lookInputSchema, lookPatchSchema } from '../domain/characters.js';
import { AppError } from '../domain/storyboard.js';

const version = z.object({ revision: z.number().int().nonnegative() });
const ids = z.object({ id: z.string().min(1).max(100), characterId: z.string().min(1).max(100).optional(), lookId: z.string().min(1).max(100).optional(), assetId: z.string().min(1).max(100).optional() });
export async function registerCharacters(app: FastifyInstance, service: CharacterService) {
  const repo = service.repo;
  app.addContentTypeParser(['image/png', 'image/jpeg', 'image/webp'], { parseAs: 'buffer' }, (_req, body, done) => done(null, body));
  app.get('/api/projects/:id/characters', async req => repo.characters.snapshot(ids.parse(req.params).id));
  app.post('/api/projects/:id/enable-v2', async req => { const { id } = ids.parse(req.params); service.assertIdle(id); return repo.enableV2(id, version.parse(req.body).revision); });
  app.post('/api/projects/:id/characters', async req => {
    const { id } = ids.parse(req.params); const { revision, ...data } = characterInputSchema.extend({ revision: version.shape.revision }).parse(req.body);
    service.assertIdle(id); const result = repo.characters.createCharacter(id, revision, data); repo.event(id, 'character.created', { libraryRevision: result.revision }); return result;
  });
  app.patch('/api/projects/:id/characters/:characterId', async req => {
    const { id, characterId } = ids.parse(req.params); const { revision, ...data } = characterPatchSchema.extend({ revision: version.shape.revision }).parse(req.body);
    service.assertIdle(id); const result = repo.characters.updateCharacter(id, revision, characterId!, data); repo.event(id, 'character.updated', { characterId, libraryRevision: result.revision }); return result;
  });
  app.delete('/api/projects/:id/characters/:characterId', async req => { const { id, characterId } = ids.parse(req.params); service.assertIdle(id); return repo.characters.deleteCharacter(id, version.parse(req.body).revision, characterId!); });
  app.get('/api/projects/:id/characters/:characterId/impact', async req => { const { id, characterId } = ids.parse(req.params); const { lookId } = z.object({ lookId: z.string().max(100).optional() }).parse(req.query); return { shotIds: repo.characters.impact(id, characterId!, lookId) }; });
  app.post('/api/projects/:id/characters/:characterId/looks', async req => {
    const { id, characterId } = ids.parse(req.params); const { revision, ...data } = lookInputSchema.extend({ revision: version.shape.revision }).parse(req.body);
    service.assertIdle(id); return repo.characters.createLook(id, revision, characterId!, data);
  });
  app.patch('/api/projects/:id/characters/:characterId/looks/:lookId', async req => {
    const { id, characterId, lookId } = ids.parse(req.params); const { revision, ...data } = lookPatchSchema.extend({ revision: version.shape.revision }).parse(req.body);
    service.assertIdle(id); return repo.characters.updateLook(id, revision, characterId!, lookId!, data);
  });
  app.delete('/api/projects/:id/characters/:characterId/looks/:lookId', async req => { const { id, characterId, lookId } = ids.parse(req.params); service.assertIdle(id); return repo.characters.deleteLook(id, version.parse(req.body).revision, characterId!, lookId!); });
  app.post('/api/projects/:id/characters/:characterId/looks/:lookId/select-version', async req => {
    const { id, characterId, lookId } = ids.parse(req.params); const input = version.extend({ versionId: z.string().min(1).max(100) }).parse(req.body);
    service.assertIdle(id); return repo.characters.selectVersion(id, input.revision, characterId!, lookId!, input.versionId);
  });
  app.post('/api/projects/:id/characters/approve', async req => {
    const { id } = ids.parse(req.params); service.assertIdle(id); const result = repo.characters.approve(id, version.parse(req.body).revision);
    repo.event(id, 'characters.approved', { libraryRevision: result.revision, manifestHash: result.approval?.manifestHash }); return result;
  });
  app.get('/api/projects/:id/portrait-estimate', async req => { repo.getProject(ids.parse(req.params).id); return service.estimate(); });
  app.put('/api/projects/:id/characters/:characterId/looks/:lookId/image', { bodyLimit: MAX_PORTRAIT_BYTES }, async req => {
    const { id, characterId, lookId } = ids.parse(req.params); const revision = z.coerce.number().int().nonnegative().parse(req.headers['x-library-revision']);
    if (!Buffer.isBuffer(req.body)) throw new AppError(400, '请提交图片二进制内容');
    return service.upload(id, revision, characterId!, lookId!, req.body, String(req.headers['content-type']));
  });
  app.post('/api/projects/:id/characters/:characterId/looks/:lookId/portrait', async req => {
    const { id, characterId, lookId } = ids.parse(req.params);
    const input = version.extend({ requestId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/), acceptCost: z.boolean() }).strict().parse(req.body);
    return service.generate(id, { ...input, characterId: characterId!, lookId: lookId! });
  });
  app.get('/api/projects/:id/character-images/:assetId', async (req, reply) => {
    const { id, assetId } = ids.parse(req.params); const { asset, relativePath } = service.image(id, assetId!);
    return reply.type(asset.mime).header('Cache-Control', 'private, max-age=3600').sendFile(relativePath, service.root);
  });
}
