import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { z, ZodError } from 'zod';
import { resolve, relative, isAbsolute } from 'node:path';
import { AppError } from '../domain/storyboard.js';
import type { Repository } from '../storage/repository.js';
import type { Workflow } from '../workflow/workflow.js';
import type { CharacterService } from '../characters/service.js';
import { registerCharacters } from './characters.js';
import { ProductionService } from '../production/service.js';
import { registerProduction } from './production.js';

interface Options { repo: Repository; workflow: Workflow; characters?: CharacterService; dataRoot: string; staticRoot?: string; publicConfig: Record<string, unknown>; }
const revision = z.object({ revision: z.number().int().nonnegative() });
export async function createApp(o: Options) {
  const app = Fastify({ logger: false, bodyLimit: 256 * 1024 });
  await app.register(fastifyStatic, { root: resolve(o.dataRoot), serve: false });
  app.addHook('onRequest', async (req) => {
    const host = req.headers.host || ''; const hostname = host.replace(/:\d+$/, '');
    if (!['localhost', '127.0.0.1', '[::1]'].includes(hostname)) throw new AppError(403, '仅允许本机访问');
    if (req.headers.origin && req.headers.origin !== `${req.protocol}://${host}`) throw new AppError(403, '不允许跨来源请求');
  });
  app.setErrorHandler((error, _req, reply) => {
    if (error instanceof ZodError) return reply.code(400).send({ error: '输入校验失败', details: error.issues.map(x => ({ path: x.path.join('.'), message: x.message })) });
    if (error instanceof AppError) return reply.code(error.status).send({ error: error.message });
    const status = error instanceof Error && 'statusCode' in error ? Number(error.statusCode) : 0;
    if (status >= 400 && status < 500) return reply.code(status).send({ error: '请求无效' });
    return reply.code(500).send({ error: '服务内部错误，请查看任务状态后重试' });
  });
  app.get('/api/config', async () => o.publicConfig);
  app.get('/api/health', async () => ({ status: 'ok' }));
  app.get('/api/projects', async () => o.repo.listProjects());
  app.post('/api/projects', async (req, reply) => { const input = z.object({ story: z.string().trim().min(1).max(20000), workflowVersion: z.union([z.literal(1), z.literal(2)]).optional() }).parse(req.body); return reply.code(201).send(o.repo.createProject(input.story, input.workflowVersion === 1 ? undefined : input.workflowVersion === 2 || o.characters ? 2 : undefined)); });
  const param = (req: { params: unknown }) => z.object({ id: z.string().min(1).max(100) }).parse(req.params).id;
  app.get('/api/projects/:id', async req => {
    const id = param(req); const project = o.repo.getProject(id);
    return { project, jobs: o.repo.jobs(id), artifacts: o.repo.artifacts(id).map(({ path: _path, ...a }) => ({ ...a, url: `/api/artifacts/${a.id}` })), events: o.repo.events(id), ...(o.characters ? { characterLibrary: o.repo.characters.snapshot(id), portraitJobs: o.characters.jobs.list(id) } : {}) };
  });
  app.post('/api/projects/:id/plan', async req => { const id = param(req); o.characters?.assertIdle(id); return o.workflow.plan(id, revision.parse(req.body).revision); });
  app.put('/api/projects/:id/storyboard', async req => {
    const id = param(req); if (o.repo.getProject(id).status === 'planning') throw new AppError(409, '正在规划，请等待完成');
    o.characters?.assertIdle(id);
    const input = revision.extend({ storyboard: z.unknown() }).parse(req.body); return o.repo.saveStoryboard(id, input.revision, input.storyboard);
  });
  app.get('/api/projects/:id/estimate', async req => o.workflow.estimate(param(req)));
  app.post('/api/projects/:id/approve', async req => {
    const id = param(req); if (o.repo.getProject(id).status === 'planning') throw new AppError(409, '正在规划，请等待完成');
    return o.repo.approve(id, revision.parse(req.body).revision);
  });
  app.post('/api/projects/:id/generate', async (req, reply) => reply.code(202).send(await o.workflow.start(param(req), revision.parse(req.body).revision)));
  app.get('/api/artifacts/:id', async (req, reply) => {
    const artifact = o.repo.getArtifact(param(req)); const path = resolve(o.dataRoot, artifact.path); const rel = relative(resolve(o.dataRoot), path);
    if (rel.startsWith('..') || isAbsolute(rel)) throw new AppError(403, '产物路径无效');
    if ((req.query as { download?: string }).download === '1') reply.header('Content-Disposition', `attachment; filename="story-${artifact.id}.${artifact.kind === 'image' ? 'png' : 'mp4'}"`);
    return reply.type(artifact.mime).header('Cache-Control', 'private, max-age=3600').sendFile(rel, resolve(o.dataRoot));
  });
  if (o.characters) await registerCharacters(app, o.characters);
  await registerProduction(app, new ProductionService(o.repo, o.dataRoot));
  if (o.staticRoot) {
    app.get('/', async (_req, reply) => reply.type('text/html').sendFile('index.html', resolve(o.staticRoot!)));
    app.get('/assets/*', async (req, reply) => reply.sendFile(`assets/${(req.params as { '*': string })['*']}`, resolve(o.staticRoot!)));
  }
  return app;
}
