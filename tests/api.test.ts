import { test, expect, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from '../src/server/app.js';
import { Repository } from '../src/storage/repository.js';
import { Workflow } from '../src/workflow/workflow.js';
import { AppError } from '../src/domain/storyboard.js';
import { board } from './fixtures.js';
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const f of cleanup.splice(0)) await f(); });
async function app(missing = false) {
  const root = await mkdtemp(join(tmpdir(), 'story-api-')); const repo = new Repository(join(root, 'app.db'));
  const output = async (_: unknown, p: string) => { await mkdir(dirname(p), { recursive: true }); await writeFile(p, 'media'); };
  const workflow = new Workflow(repo, { plan: async () => { if (missing) throw new AppError(503, '请配置模型密钥'); return board(7); } }, { simulated: true, image: output, video: output }, { compose: (i, p) => output(i, p) }, root);
  const server = await createApp({ repo, workflow, dataRoot: root, publicConfig: { plannerConfigured: !missing, mediaConfigured: true, videoModel: 'test-model', simulated: true } });
  cleanup.push(async () => { await workflow.idle(); await server.close(); repo.close(); await rm(root, { recursive: true, force: true }); }); return { server, repo, workflow };
}
test('HTTP loop validates, plans, edits and binds approval to revision', async () => {
  const { server, workflow } = await app();
  expect((await server.inject({ method: 'POST', url: '/api/projects', payload: { story: '' } })).statusCode).toBe(400);
  const created = await server.inject({ method: 'POST', url: '/api/projects', payload: { story: '狐狸给月亮送信' } }); const id = created.json().id;
  const planned = await server.inject({ method: 'POST', url: `/api/projects/${id}/plan`, payload: { revision: 0 } }); expect(planned.json().storyboard.shots).toHaveLength(7);
  expect((await server.inject({ method: 'POST', url: `/api/projects/${id}/generate`, payload: { revision: 1 } })).statusCode).toBe(409);
  await server.inject({ method: 'POST', url: `/api/projects/${id}/approve`, payload: { revision: 1 } });
  await server.inject({ method: 'PUT', url: `/api/projects/${id}/storyboard`, payload: { revision: 1, storyboard: board(2) } });
  expect((await server.inject({ method: 'POST', url: `/api/projects/${id}/generate`, payload: { revision: 1 } })).statusCode).toBe(409);
  await server.inject({ method: 'POST', url: `/api/projects/${id}/approve`, payload: { revision: 2 } });
  expect((await server.inject({ method: 'POST', url: `/api/projects/${id}/generate`, payload: { revision: 2 } })).statusCode).toBe(202); await workflow.idle(id);
  const detail = (await server.inject(`/api/projects/${id}`)).json(); expect(detail.project.status).toBe('ready'); expect(detail.artifacts).toHaveLength(5);
  expect(detail.artifacts[0].path).toBeUndefined(); expect((await server.inject(detail.artifacts[0].url)).statusCode).toBe(200);
});
test('configuration failure is explicit and cannot start media', async () => {
  const { server } = await app(true); const id = (await server.inject({ method: 'POST', url: '/api/projects', payload: { story: '故事' } })).json().id;
  expect((await server.inject({ method: 'POST', url: `/api/projects/${id}/plan`, payload: { revision: 0 } })).statusCode).toBe(503);
  const config = (await server.inject('/api/config')).json(); expect(config.plannerConfigured).toBe(false); expect(JSON.stringify(config)).not.toMatch(/Bearer|apiKey/);
});
test('rejects cross-origin writes, unknown artifacts and >20 shots', async () => {
  const { server } = await app(); expect((await server.inject({ method: 'POST', url: '/api/projects', headers: { origin: 'https://evil.example' }, payload: { story: '故事' } })).statusCode).toBe(403);
  expect((await server.inject('/api/artifacts/not-known')).statusCode).toBe(404);
  const id = (await server.inject({ method: 'POST', url: '/api/projects', payload: { story: '故事' } })).json().id;
  expect((await server.inject({ method: 'PUT', url: `/api/projects/${id}/storyboard`, payload: { revision: 0, storyboard: board(21) } })).statusCode).toBe(400);
});
