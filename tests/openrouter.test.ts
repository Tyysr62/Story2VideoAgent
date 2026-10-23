import { createHash } from 'node:crypto';
import { test, expect } from 'vitest';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OpenRouterMedia, DEFAULT_IMAGE_MODEL, DEFAULT_VIDEO_MODEL } from '../src/media/openrouter.js';
import { board } from './fixtures.js';

test('failed image response preserves redacted diagnostics without exposing upstream payload or resubmitting', async () => {
  const root = await mkdtemp(join(tmpdir(), 'story-image-error-')); let calls = 0;
  try {
    const media = new OpenRouterMedia({ apiKey: 'sk-or-fixture-private', diagnosticRoot: root, fetcher: async () => {
      calls++; return Response.json({ error: { code: 400, message: 'Provider rejected field resolution', metadata: { raw: 'Authorization: Bearer sk-or-fixture-private', api_key: 'sk-or-fixture-private' } } }, { status: 400 });
    } });
    let failure: Error | undefined; try { await media.portrait('角色参考图', join(root, 'out.image')); } catch (error) { failure = error as Error; }
    expect(calls).toBe(1); expect(failure?.message).toContain('HTTP 400'); expect(failure?.message).toContain('诊断编号');
    expect(failure?.message).not.toContain('Provider rejected'); expect(failure?.message).not.toContain('sk-or-fixture-private');
    const files = await readdir(root); const diagnostic = files.find(file => file.endsWith('.json')); expect(diagnostic).toBeDefined();
    const log = await readFile(join(root, diagnostic!), 'utf8'); expect(log).toContain('Provider rejected field resolution'); expect(log).not.toContain('sk-or-fixture-private');
  } finally { await rm(root, { recursive: true, force: true }); }
});

const catalog = { data: [{ id: DEFAULT_VIDEO_MODEL, supported_durations: [5, 6, 10, 15], supported_resolutions: ['480p', '768p'], supported_aspect_ratios: ['16:9'], pricing_skus: { duration_seconds_480p: '0.05' } }] };

test('user-selected Qwen Turbo and HeyGen defaults use compatible resolution and image pricing', async () => {
  expect(DEFAULT_IMAGE_MODEL).toBe('qwen/qwen-image-2.1-turbo');
  expect(DEFAULT_VIDEO_MODEL).toBe('heygen/heygen-video-1');
  const root = await mkdtemp(join(tmpdir(), 'story-qwen-')); const requests: { url: string; init?: RequestInit }[] = [];
  try {
    const media = new OpenRouterMedia({ apiKey: 'fixture-only', fetcher: async (input, init) => {
      const url = String(input); requests.push({ url, init });
      if (url.endsWith('/endpoints')) return Response.json({ endpoints: [{ pricing: [
        { billable: 'output_image', unit: 'image', variant: '1k', cost_usd: 0.0184 },
        { billable: 'output_image', unit: 'image', variant: '2k', cost_usd: 0.0184 },
      ] }] });
      if (url.endsWith('/videos/models')) return Response.json({ data: [{ ...catalog.data[0], pricing_skus: { duration_seconds_480p: '0.02' } }] });
      return Response.json({ data: [{ b64_json: 'iVBORw0KGgo=', media_type: 'image/png' }] });
    } });
    expect(media.portraitConfig()).toMatchObject({ model: DEFAULT_IMAGE_MODEL, parameters: { resolution: '2K', aspect_ratio: '1:1' } });
    expect((await media.estimatePortrait()).imageUsd).toBeCloseTo(0.0184);
    const b = board(); b.shots.forEach(s => s.duration = 5);
    expect(await media.estimate(b)).toMatchObject({ videoUsd: 0.2, imageUsd: 0.0368 });
    await media.portrait('单人角色图', join(root, 'portrait.png'));
    await media.image(b.shots[0], join(root, 'shot.png'));
    const bodies = requests.filter(r => r.init?.method === 'POST').map(r => JSON.parse(String(r.init?.body)));
    expect(bodies).toEqual([
      { model: DEFAULT_IMAGE_MODEL, prompt: '单人角色图', resolution: '2K', aspect_ratio: '1:1', n: 1 },
      { model: DEFAULT_IMAGE_MODEL, prompt: b.shots[0].imagePrompt, resolution: '2K', aspect_ratio: '16:9', n: 1 },
    ]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
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
    expect(request).toMatchObject({ model: DEFAULT_VIDEO_MODEL, duration: 5, resolution: '480p' });
    expect(request).not.toHaveProperty('generate_audio');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('non-HeyGen audio requests require an explicit audio capability before any paid POST', async () => {
  const root = await mkdtemp(join(tmpdir(), 'story-audio-routing-')); const requests: any[] = []; let supported = false;
  try {
    const fetcher: typeof fetch = async (input, init) => {
      if (init?.method === 'POST') requests.push(JSON.parse(String(init.body)));
      if (String(input).endsWith('/videos/models')) return Response.json({ data: [{ ...catalog.data[0], id: 'fixture/video', generate_audio: supported }] });
      if (String(input).endsWith('/videos')) return Response.json({ id: 'audio-task' });
      if (String(input).includes('/content')) return new Response(new Uint8Array([1]));
      return Response.json({ status: 'completed' });
    };
    const b: any = board(1); b.shots[0].duration = 5; b.shots[0].audio = { mode: 'ambient', dialogue: [], narration: null, ambience: '雨声', soundEffects: [], music: 'none' };
    const unsupported = new OpenRouterMedia({ apiKey: 'fixture', videoModel: 'fixture/video', fetcher, pollMs: 0 });
    await expect(unsupported.validate(b)).rejects.toThrow(/声音|音频/); expect(requests).toEqual([]);
    supported = true; const media = new OpenRouterMedia({ apiKey: 'fixture', videoModel: 'fixture/video', fetcher, pollMs: 0 });
    await media.video(b.shots[0], join(root, 'audio.mp4'), { persistTaskId() {} }); expect(requests[0].generate_audio).toBe(true);
    delete b.shots[0].audio; await media.video(b.shots[0], join(root, 'silent.mp4'), { persistTaskId() {} }); expect(requests[1].generate_audio).toBe(false);
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

test('reference-conditioned keyframes pin a capable endpoint and transmit ordered data URLs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'story-refs-')); const requests: { url: string; init?: RequestInit }[] = [];
  try {
    await import('node:fs/promises').then(fs => fs.writeFile(join(root, 'ref.png'), Buffer.from('reference-pixels')));
    const media = new OpenRouterMedia({ apiKey: 'fixture-only', fetcher: async (input, init) => {
      const url = String(input); requests.push({ url, init });
      if (url.endsWith('/endpoints')) return Response.json({ endpoints: [{ provider_tag: 'alibaba', supported_parameters: { resolution: { type: 'enum', values: ['1K', '2K'] }, aspect_ratio: { type: 'enum', values: ['16:9'] }, n: { type: 'range', min: 1, max: 6 }, input_references: { type: 'range', min: 0, max: 4 } } }] });
      return Response.json({ data: [{ b64_json: 'iVBORw0KGgo=', media_type: 'image/png' }] });
    } });
    await expect(media.validateKeyframe(5)).rejects.toThrow(/参考|支持/); expect(requests.every(r => r.init?.method !== 'POST')).toBe(true);
    await media.keyframe({ prompt: '参考图 1 为爷爷', references: [{ assetId: 'a', path: join(root, 'ref.png'), mime: 'image/png', sha256: createHash('sha256').update('reference-pixels').digest('hex') }] }, join(root, 'frame.png'));
    const post = JSON.parse(String(requests.find(r => r.init?.method === 'POST')?.init?.body));
    expect(post).toMatchObject({ model: DEFAULT_IMAGE_MODEL, resolution: '2K', aspect_ratio: '16:9', provider: { only: ['alibaba'], allow_fallbacks: false } });
    expect(post.input_references).toEqual([{ type: 'image_url', image_url: { url: `data:image/png;base64,${Buffer.from('reference-pixels').toString('base64')}` } }]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('image-to-video sends first_frame and prices reference generation instead of text-only rates', async () => {
  const root = await mkdtemp(join(tmpdir(), 'story-i2v-')); const requests: { url: string; init?: RequestInit }[] = [];
  try {
    const media = new OpenRouterMedia({ apiKey: 'fixture', pollMs: 0, fetcher: async (input, init) => {
      const url = String(input); requests.push({ url, init });
      if (url.endsWith('/videos/models')) return Response.json({ data: [{ ...catalog.data[0], supported_frame_images: ['first_frame'], pricing_skus: { duration_seconds_480p: '0.02', reference_duration_seconds_480p: '0.07', reference_input_images: '0.04' } }] });
      if (url.endsWith('/videos')) return Response.json({ id: 'i2v-task' });
      if (url.includes('/content')) return new Response(Buffer.from('video-fixture'));
      return Response.json({ status: 'completed' });
    } });
    const b = board(1); b.shots[0].duration = 5; await media.validateImageToVideo(b); expect((await media.estimateImageToVideo(b)).videoUsd).toBeCloseTo(0.39);
    await media.video(b.shots[0], join(root, 'v.mp4'), { firstFrameUrl: 'https://bucket.example/frame.png?signed=fixture', persistTaskId() {} });
    const post = JSON.parse(String(requests.find(r => r.init?.method === 'POST')?.init?.body)); expect(post.frame_images).toEqual([{ type: 'image_url', image_url: { url: 'https://bucket.example/frame.png?signed=fixture' }, frame_type: 'first_frame' }]);
  } finally { await rm(root, { recursive: true, force: true }); }
});


test('portrait reference editing pins a square-capable provider and rejects changed source bytes before billing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'portrait-ref-')); const posts: any[] = []; let supported = true;
  try {
    const path = join(root, 'ref.png'); await import('node:fs/promises').then(fs => fs.writeFile(path, 'original'));
    const reference = { assetId: 'source', path, mime: 'image/png', sha256: createHash('sha256').update('original').digest('hex') };
    const media = new OpenRouterMedia({ apiKey: 'fixture', fetcher: async (_, init) => {
      if (init?.method !== 'POST') return Response.json({ endpoints: [{ provider_tag: 'alibaba', supported_parameters: {
        resolution: { values: ['2K'] }, aspect_ratio: { values: supported ? ['1:1'] : ['16:9'] }, n: { min: 1, max: 6 }, input_references: { type: 'range', min: 0, max: 4 }
      } }] });
      posts.push(JSON.parse(String(init.body))); return Response.json({ data: [{ b64_json: 'iVBORw0KGgo=', media_type: 'image/png' }] });
    } });
    await media.portrait('same person, winter coat', join(root, 'out.png'), reference);
    expect(posts[0]).toMatchObject({ resolution: '2K', aspect_ratio: '1:1', provider: { only: ['alibaba'], allow_fallbacks: false }, input_references: [{ type: 'image_url', image_url: { url: `data:image/png;base64,${Buffer.from('original').toString('base64')}` } }] });
    supported = false;
    await expect(media.portrait('edit', join(root, 'out.png'), reference)).rejects.toThrow(/支持/);
    supported = true; await import('node:fs/promises').then(fs => fs.writeFile(path, 'modified'));
    await expect(media.portrait('edit', join(root, 'out.png'), reference)).rejects.toThrow(/摘要|修改|校验/);
    expect(posts).toHaveLength(1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('an explicit 1K override is retained for image and portrait configuration', () => {
  const media = new OpenRouterMedia({ apiKey: 'fixture', imageResolution: '1K' });
  expect(media.portraitConfig().parameters.resolution).toBe('1K');
  expect(media.generationConfig('image').parameters.resolution).toBe('1K');
});
