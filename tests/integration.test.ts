import { test, expect, afterEach } from 'vitest';
import { createServer } from 'node:http';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { PiDirector } from '../src/director/pi-director.js';
import { OpenRouterMedia, DEFAULT_VIDEO_MODEL } from '../src/media/openrouter.js';
import { FfmpegComposer, MockMedia, runFfmpeg, inspectMedia } from '../src/media/ffmpeg.js';
import { silentAudio } from '../src/domain/audio.js';
import type { Storyboard } from '../src/domain/storyboard.js';
import { Repository } from '../src/storage/repository.js';
import { Workflow } from '../src/workflow/workflow.js';
import { createApp } from '../src/server/app.js';
import { board } from './fixtures.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const f of cleanup.splice(0).reverse()) await f(); });
async function fixture(withAudio = false) {
  const root = await mkdtemp(join(tmpdir(), 'story-integration-')); cleanup.push(() => rm(root, { recursive: true, force: true }));
  const b: Storyboard = board(2); if (withAudio) b.shots[0].audio = { ...silentAudio(), mode: 'speech', narration: { text: '那封信，他保存了四十年。', delivery: '温柔' } }; const png = join(root, 'source.png'), clip = join(root, 'source.mp4');
  const mock = new MockMedia(); await mock.image(b.shots[0], png); await mock.video(b.shots[0], clip);
  const image = await readFile(png), video = await readFile(clip); const submits: string[] = [];
  const fetcher: typeof fetch = async (input, options) => {
    const url = new URL(String(input)); const path = url.pathname;
    if (options?.method === 'POST') submits.push(path);
    if (path.endsWith('/videos/models')) return Response.json({ data: [{ id: DEFAULT_VIDEO_MODEL, supported_durations: [1], supported_resolutions: ['480p'], supported_aspect_ratios: ['16:9'], pricing_skus: { duration_seconds_480p: '0.05' } }] });
    if (path.endsWith('/images')) return Response.json({ data: [{ b64_json: image.toString('base64'), media_type: 'image/png' }] });
    if (path.endsWith('/videos')) return Response.json({ id: `remote-${submits.length}` });
    if (path.endsWith('/content')) return new Response(video, { headers: { 'Content-Type': 'video/mp4' } });
    if (/\/videos\/remote-/.test(path)) return Response.json({ id: path.split('/').at(-1), status: 'completed' });
    throw new Error(`Unexpected fixture URL: ${path}`);
  };
  return { root, b, png, image, submits, media: new OpenRouterMedia({ apiKey: 'fixture-only', fetcher, pollMs: 0 }) };
}

test('real Pi HTTP transport → HTTP approval → cloud adapter fixtures → real FFmpeg → persisted playback', async () => {
  const { root, b, submits, media } = await fixture(true); const requests: any[] = [];
  const modelServer = createServer(async (req, res) => {
    let raw = ''; for await (const part of req) raw += part; const input = JSON.parse(raw); requests.push(input);
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    const first = requests.length === 1;
    const delta = first ? { role: 'assistant', tool_calls: [{ index: 0, id: 'proposal-http', type: 'function', function: { name: 'propose_storyboard', arguments: JSON.stringify(b) } }] } : { role: 'assistant', content: '草案已提交。' };
    const chunk = (d: unknown, finish: string | null) => `data: ${JSON.stringify({ id: 'chat-fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture-model', choices: [{ index: 0, delta: d, finish_reason: finish }] })}\n\n`;
    res.end(chunk(delta, null) + chunk({}, first ? 'tool_calls' : 'stop') + 'data: [DONE]\n\n');
  });
  await new Promise<void>(r => modelServer.listen(0, '127.0.0.1', r)); cleanup.push(() => new Promise<void>((r, reject) => modelServer.close(e => e ? reject(e) : r())));
  const port = (modelServer.address() as { port: number }).port;
  const repo = new Repository(join(root, 'story.db')); cleanup.push(async () => repo.close());
  const planner = new PiDirector({ apiKey: 'fixture-only', model: 'fixture-model', baseUrl: `http://127.0.0.1:${port}/v1`, timeoutMs: 15000 });
  const workflow = new Workflow(repo, planner, media, new FfmpegComposer(), root);
  const app = await createApp({ repo, workflow, dataRoot: root, publicConfig: { simulated: false } }); cleanup.push(async () => { await workflow.idle(); await app.close(); });
  const id = (await app.inject({ method: 'POST', url: '/api/projects', payload: { story: '狐狸的月光邮局' } })).json().id;
  const response = await app.inject({ method: 'POST', url: `/api/projects/${id}/plan`, payload: { revision: 0 } });
  expect(response.statusCode, response.body).toBe(200); expect(requests).toHaveLength(2);
  expect(requests[0].tools.map((t: any) => t.function.name)).toEqual(['propose_storyboard']);
  expect(requests[0].model).toBe('fixture-model'); expect(requests[1].messages.some((m: any) => m.role === 'tool')).toBe(true);
  expect(submits).toEqual([]);
  await app.inject({ method: 'POST', url: `/api/projects/${id}/approve`, payload: { revision: 1 } });
  await app.inject({ method: 'POST', url: `/api/projects/${id}/generate`, payload: { revision: 1 } }); await workflow.idle(id);
  expect(repo.getProject(id).status).toBe('ready'); expect(submits.filter(x => x.endsWith('/videos'))).toHaveLength(2);
  const final = repo.getArtifact(repo.getProject(id).finalArtifactId!);
  await runFfmpeg(['-i', join(root, final.path), '-f', 'null', '-']);
  expect(final.bytes).toBeGreaterThan(1000);
  expect((await inspectMedia(join(root, final.path))).hasAudio).toBe(true);
  const pcm = join(root, 'final-audio.pcm');
  await runFfmpeg(['-ss', '0.2', '-i', join(root, final.path), '-t', '0.15', '-map', '0:a:0', '-f', 's16le', pcm]);
  expect((await readFile(pcm)).some(byte => byte !== 0)).toBe(true);
  const videoEntries = repo.production.list(id).filter(e => e.kind === 'video');
  expect(videoEntries.find(e => e.shotId === b.shots[0].id)?.prompt).toContain('那封信，他保存了四十年。');
  expect(videoEntries.find(e => e.shotId === b.shots[1].id)?.prompt).toContain('完全静音');
  const range = await app.inject({ url: `/api/artifacts/${final.id}`, headers: { range: 'bytes=0-99' } }); expect(range.statusCode).toBe(206); expect(range.rawPayload.length).toBe(100);
});

test('close/reopen resumes saved cloud task ID and preserves completed image without another paid submission', async () => {
  const { root, b, png, image, submits, media } = await fixture(); b.shots = b.shots.slice(0, 1);
  let repo = new Repository(join(root, 'recovery.db')); const p = repo.createProject('被中断的故事'); repo.saveStoryboard(p.id, 0, b); repo.approve(p.id, 1);
  const imageJob = repo.ensureJob({ projectId: p.id, revision: 1, kind: 'image', shotId: b.shots[0].id });
  repo.saveArtifact({ id: imageJob.id, projectId: p.id, revision: 1, shotId: b.shots[0].id, kind: 'image', path: relative(root, png), mime: 'image/png', bytes: image.length, sha256: 'fixture', simulated: false, createdAt: new Date().toISOString() });
  repo.updateJob(imageJob.id, { status: 'succeeded', artifactId: imageJob.id, attempts: 1 });
  const job = repo.ensureJob({ projectId: p.id, revision: 1, kind: 'video', shotId: b.shots[0].id }); repo.updateJob(job.id, { status: 'running', attempts: 5, providerTaskId: 'remote-saved' }); repo.updateProject(p.id, { status: 'generating' }); repo.close();
  repo = new Repository(join(root, 'recovery.db')); cleanup.push(async () => repo.close());
  const workflow = new Workflow(repo, { plan: async () => b }, media, new FfmpegComposer(), root); cleanup.push(() => workflow.idle());
  await workflow.recover(); await workflow.idle(p.id);
  expect(repo.getProject(p.id).status).toBe('ready'); expect(submits).toEqual([]);
  expect(repo.getJob(job.id).providerTaskId).toBe('remote-saved'); expect(repo.getJob(imageJob.id).attempts).toBe(1);
  const final = repo.getArtifact(repo.getProject(p.id).finalArtifactId!); expect((await stat(join(root, final.path))).size).toBeGreaterThan(1000);
});
