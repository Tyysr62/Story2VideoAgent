import { test, expect } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OpenRouterMedia, DEFAULT_VIDEO_MODEL } from '../src/media/openrouter.js';
import { board } from './fixtures.js';

const catalog = { data: [{ id: DEFAULT_VIDEO_MODEL, supported_durations: [5, 6, 10, 15], supported_resolutions: ['480p', '768p'], supported_aspect_ratios: ['16:9'], pricing_skus: { duration_seconds_480p: '0.05' } }] };
function stub() {
  const requests: { url: string; init?: RequestInit }[] = [];
  const f: typeof fetch = async (input, init) => {
    const url = String(input); requests.push({ url, init });
    if (url.endsWith('/videos/models')) return Response.json(catalog);
    if (url.endsWith('/images')) return Response.json({ data: [{ b64_json: 'iVBORw0KGgo=', media_type: 'image/png' }], usage: { cost: 0.008 } });
    if (url.endsWith('/videos') && init?.method === 'POST') return Response.json({ id: 'job-real-id', status: 'pending' }, { status: 202 });
    if (url.includes('/content')) return new Response(new Uint8Array([1, 2, 3]));
    return Response.json({ id: 'job-real-id', status: 'completed', usage: { cost: 0.25 } });
  };
  return { f, requests };
}
test('discovers capabilities and prices before paid calls; rejects unsupported duration', async () => {
  const s = stub(); const media = new OpenRouterMedia({ apiKey: 'secret', fetcher: s.f, pollMs: 0 });
  const b = board(); b.shots.forEach(x => x.duration = 5);
  expect((await media.estimate(b)).videoUsd).toBeCloseTo(0.5);
  b.shots[0].duration = 1; await expect(media.validate(b)).rejects.toThrow(/时长/);
  expect(s.requests.every(x => !x.init?.method || x.init.method === 'GET')).toBe(true);
});
test('uses real OpenRouter image/video contracts and persists task ID before polling', async () => {
  const root = await mkdtemp(join(tmpdir(), 'story-cloud-')); const s = stub(); const saved: string[] = [];
  try {
    const media = new OpenRouterMedia({ apiKey: 'secret', fetcher: s.f, pollMs: 0 }); const shot = board().shots[0]; shot.duration = 5;
    await media.image(shot, join(root, 'img.png'));
    await media.video(shot, join(root, 'video.mp4'), { persistTaskId: id => saved.push(id) });
    expect(saved).toEqual(['job-real-id']); expect((await readFile(join(root, 'video.mp4'))).length).toBe(3);
    const request = JSON.parse(String(s.requests.find(x => x.url.endsWith('/videos'))!.init!.body));
    expect(request).toMatchObject({ model: DEFAULT_VIDEO_MODEL, duration: 5, resolution: '480p', generate_audio: false });
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('resumes persisted cloud jobs without a new paid submission', async () => {
  const root = await mkdtemp(join(tmpdir(), 'story-cloud-')); const s = stub();
  try {
    const media = new OpenRouterMedia({ apiKey: 'secret', fetcher: s.f, pollMs: 0 });
    await media.video(board().shots[0], join(root, 'video.mp4'), { providerTaskId: 'existing', persistTaskId: () => { throw Error('must not submit'); } });
    expect(s.requests.some(x => x.init?.method === 'POST')).toBe(false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('a timed out submission is uncertain and cannot be silently replayed', async () => {
  const media = new OpenRouterMedia({ apiKey: 'secret', fetcher: async () => { throw Error('timeout'); } });
  await expect(media.video(board().shots[0], 'unused', { persistTaskId() {} })).rejects.toMatchObject({ uncertain: true });
});

test('an accepted image whose local write fails must not become a safe-to-repeat submission', async () => {
  const root = await mkdtemp(join(tmpdir(), 'story-image-failed-save-')); const s = stub();
  try {
    const media = new OpenRouterMedia({ apiKey: 'fixture-only', fetcher: s.f });
    // A directory is not a writable image file; the paid response has already arrived.
    await expect(media.image(board().shots[0], root)).rejects.toMatchObject({ uncertain: true });
    expect(s.requests.filter(x => x.init?.method === 'POST')).toHaveLength(1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test.each(['persistence-error', 'null-response'])('accepted video with %s becomes uncertain without polling or resubmission', async scenario => {
  const s = stub(); const fetcher: typeof fetch = async (...args) => { const response = await s.f(...args); return scenario === 'null-response' ? Response.json(null) : response; };
  const media = new OpenRouterMedia({ apiKey: 'fixture-only', fetcher, pollMs: 0 });
  await expect(media.video(board().shots[0], 'unused', { persistTaskId() { throw Error('database write failed'); } })).rejects.toMatchObject({ uncertain: true });
  expect(s.requests).toHaveLength(1); expect(s.requests[0].init?.method).toBe('POST');
});
test('never sends the API key to a redirected CDN', async () => {
  const root = await mkdtemp(join(tmpdir(), 'story-cloud-')); const seen: { url: string; auth: string | null }[] = [];
  const media = new OpenRouterMedia({ apiKey: 'secret', fetcher: async (input, init) => {
    const url = String(input); seen.push({ url, auth: new Headers(init?.headers).get('authorization') });
    if (url.includes('/content')) return new Response(null, { status: 307, headers: { location: 'https://cdn.fal.media/movie.mp4' } });
    if (url.includes('cdn.fal.media')) return new Response(new Uint8Array([1]));
    return Response.json({ status: 'completed' });
  }, pollMs: 0 });
  try { await media.video(board().shots[0], join(root, 'v.mp4'), { providerTaskId: 'existing', persistTaskId() {} }); expect(seen.find(x => x.url.includes('cdn.fal.media'))!.auth).toBeNull(); }
  finally { await rm(root, { recursive: true, force: true }); }
});
