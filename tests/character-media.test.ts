import { test, expect, afterEach } from 'vitest';
import sharp from 'sharp';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { Repository } from '../src/storage/repository.js';
import { CharacterService } from '../src/characters/service.js';
import { validatePortrait } from '../src/characters/images.js';
import { UncertainSubmission, OpenRouterMedia } from '../src/media/openrouter.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
const picture = (format: 'png' | 'jpeg' | 'webp' = 'png', width = 64) => sharp({ create: { width, height: 64, channels: 3, background: '#aabbcc' } }).toFormat(format).toBuffer();
async function setup(backend?: { simulated: boolean; portrait(prompt: string, output: string): Promise<void> }) {
  const root = await mkdtemp(join(tmpdir(), 'portrait-'));
  const repo = new Repository(join(root, 'app.db')); const p = repo.createProject('一封旧信', 2);
  let lib = repo.characters.createCharacter(p.id, 0, { name: '陈伯', description: '退休教师' });
  const c = lib.characters[0]; lib = repo.characters.createLook(p.id, lib.revision, c.id, { name: '青年', description: '黑发，蓝色外套' });
  const look = lib.characters[0].looks[0];
  const service = new CharacterService(repo, root, backend ?? { simulated: true, portrait: async (_, output) => { await mkdir(dirname(output), { recursive: true }); await writeFile(output, await picture()); } });
  cleanup.push(async () => { await service.idle(); repo.close(); await rm(root, { recursive: true, force: true }); });
  return { root, repo, p, lib, c, look, service };
}

test.each(['png', 'jpeg', 'webp'] as const)('decodes genuine %s images and rejects mismatched declared MIME', async format => {
  const data = await picture(format); const mime = `image/${format}`;
  expect((await validatePortrait(data, mime)).mime).toBe(mime);
  await expect(validatePortrait(data, 'image/gif')).rejects.toThrow(/格式/);
});
test('rejects corrupt files, SVG, animation, excessive bytes and dimensions', async () => {
  await expect(validatePortrait(Buffer.from('<svg></svg>'), 'image/png')).rejects.toThrow();
  const png = await picture(); await expect(validatePortrait(png.subarray(0, 35), 'image/png')).rejects.toThrow();
  await expect(validatePortrait(Buffer.alloc(10 * 1024 * 1024 + 1), 'image/png')).rejects.toThrow(/10/);
  await expect(validatePortrait(await picture('png', 4097), 'image/png')).rejects.toThrow(/4096/);
  const pixels = Buffer.from([...Array(4).fill([255, 0, 0]).flat(), ...Array(4).fill([0, 0, 255]).flat()]);
  const animated = await sharp(pixels, { raw: { width: 2, height: 4, channels: 3, pageHeight: 2 } }).webp({ loop: 0, delay: [100, 100] }).toBuffer();
  expect((await sharp(animated).metadata()).pages).toBe(2);
  await expect(validatePortrait(animated, 'image/webp')).rejects.toThrow(/静态|动画/);
});
test('upload attaches a new immutable version and exposes only scoped metadata', async () => {
  const { service, repo, p, lib, c, look } = await setup();
  const next = await service.upload(p.id, lib.revision, c.id, look.id, await picture(), 'image/png');
  const selected = next.characters[0].looks[0]; expect(selected.versions).toHaveLength(2);
  const asset = repo.characters.getImageAsset(p.id, selected.versions.at(-1)!.imageAssetId!);
  expect(asset.sha256).toMatch(/^[a-f0-9]{64}$/); expect(asset.source).toBe('upload'); expect(asset.width).toBe(64);
  await expect(service.upload(p.id, lib.revision, c.id, look.id, await picture(), 'image/png')).rejects.toThrow(/版本/);
});
test('explicit portrait generation persists success and deduplicates a repeated request ID', async () => {
  let calls = 0; let prompt = '';
  const { service, repo, p, lib, c, look } = await setup({ simulated: false, portrait: async (text, output) => { calls++; prompt = text; await mkdir(dirname(output), { recursive: true }); await writeFile(output, await picture()); } });
  const request = { revision: lib.revision, characterId: c.id, lookId: look.id, requestId: 'request-one', acceptCost: true as const };
  const job = await service.generate(p.id, request);
  expect(job.status).toBe('succeeded'); expect(prompt).toContain('黑发'); expect(prompt).toContain('退休教师');
  expect((await service.generate(p.id, request)).id).toBe(job.id); expect(calls).toBe(1);
  expect(repo.characters.snapshot(p.id).approval).toBeNull();
});
test('unknown submissions and invalid billed outputs block subsequent paid attempts for the look', async () => {
  for (const invalidOutput of [false, true]) {
    let calls = 0;
    const { service, p, lib, c, look } = await setup({ simulated: false, portrait: async (_, output) => { calls++; if (!invalidOutput) throw new UncertainSubmission(); await mkdir(dirname(output), { recursive: true }); await writeFile(output, 'corrupt paid output'); } });
    const request = { revision: lib.revision, characterId: c.id, lookId: look.id, requestId: 'uncertain-one', acceptCost: true as const };
    expect((await service.generate(p.id, request)).status).toBe('unknown');
    await expect(service.generate(p.id, { ...request, requestId: 'uncertain-two' })).rejects.toThrow(/未知|核实/);
    expect(calls).toBe(1);
  }
});
test('paid operations require cost consent and startup never repeats interrupted POSTs', async () => {
  const { service, p, lib, c, look } = await setup();
  await expect(service.generate(p.id, { revision: lib.revision, characterId: c.id, lookId: look.id, requestId: 'no-cost-consent', acceptCost: false })).rejects.toThrow(/费用|确认/);
  service.jobs.create({ id: 'interrupted', projectId: p.id, characterId: c.id, lookId: look.id, lookVersionId: look.selectedVersionId, libraryRevision: lib.revision, inputHash: 'fixture', status: 'running', assetId: null, error: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  await service.recover(); expect(service.jobs.list(p.id)[0].status).toBe('unknown');
});
test('cloud portrait uses square image parameters and never submits a video', async () => {
  const { root } = await setup(); const calls: { url: string; body: any }[] = [];
  const media = new OpenRouterMedia({ apiKey: 'fixture', fetcher: async (url, init) => { calls.push({ url: String(url), body: JSON.parse(String(init?.body)) }); return Response.json({ data: [{ b64_json: (await picture()).toString('base64'), media_type: 'image/png' }] }); } });
  await media.portrait('单人基准图', join(root, 'portrait.image'));
  expect(calls).toHaveLength(1); expect(calls[0].url).toMatch(/\/images$/); expect(calls[0].body.aspect_ratio).toBe('1:1');
});
