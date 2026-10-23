import { test, expect, afterEach } from 'vitest';
import sharp from 'sharp';
import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { Repository } from '../src/storage/repository.js';
import { CharacterService, type PortraitBackend } from '../src/characters/service.js';
import { validatePortrait } from '../src/characters/images.js';
import { UncertainSubmission, OpenRouterMedia } from '../src/media/openrouter.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
const picture = (format: 'png' | 'jpeg' | 'webp' = 'png', width = 64) => sharp({ create: { width, height: 64, channels: 3, background: '#aabbcc' } }).toFormat(format).toBuffer();
async function setup(backend?: PortraitBackend) {
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
  expect(job.inputSnapshot).toMatchObject({ model: 'injected-adapter', identityDescription: '退休教师', lookDescription: '黑发，蓝色外套' });
  expect(repo.characters.getImageAsset(p.id, job.assetId!).generation?.prompt).toBe(prompt);
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


test('reference edits across age looks retain original pixels, immutable provenance and exportable prompts', async () => {
  let referenceUsed: any; let calls = 0;
  const { service, repo, p, lib, c, look, root } = await setup({ simulated: true, validatePortraitReference: async () => ({}), portrait: async (_, out, ref) => {
    calls++; referenceUsed = ref; await mkdir(dirname(out), { recursive: true }); await writeFile(out, await picture('webp'));
  } });
  const original = await picture(); let next = await service.upload(p.id, lib.revision, c.id, look.id, original, 'image/png');
  const source = next.characters[0].looks[0].versions.at(-1)!;
  next = repo.characters.createLook(p.id, next.revision, c.id, { name: '老年', description: '白发，皱纹，保留脸型' });
  const target = next.characters[0].looks[1];
  const request = { revision: next.revision, characterId: c.id, lookId: target.id, requestId: 'ref-age', acceptCost: true, reference: { lookId: look.id, lookVersionId: source.id }, editInstruction: '换成白发，保留五官与蓝色外套' };
  const job = await service.generate(p.id, request);
  expect(job.status).toBe('succeeded'); expect(referenceUsed.assetId).toBe(source.imageAssetId);
  expect(await readFile(referenceUsed.path)).toEqual(original);
  expect(job.inputSnapshot).toMatchObject({ editInstruction: request.editInstruction, reference: { ...request.reference, characterId: c.id, assetId: source.imageAssetId, sha256: referenceUsed.sha256 } });
  expect(job.inputSnapshot?.prompt).toContain('参考图 1'); expect(job.inputSnapshot?.prompt).toContain(request.editInstruction);
  expect(repo.characters.getImageAsset(p.id, job.assetId!).generation).toEqual(job.inputSnapshot);
  expect(repo.production.get(p.id, `portrait-request:${job.id}`).dependencies).toContain(`character:${source.imageAssetId}`);
  expect(repo.production.get(p.id, `character:${job.assetId}`).dependencies).toContain(`character:${source.imageAssetId}`);
  expect((await service.generate(p.id, request)).id).toBe(job.id); expect(calls).toBe(1);
  await expect(service.generate(p.id, { ...request, editInstruction: '不同修改' })).rejects.toThrow(/编号|输入/);
  await expect(service.generate(p.id, { ...request, reference: undefined })).rejects.toThrow(/编号|输入/);
  const { ProductionService } = await import('../src/production/service.js'); const { unzipSync } = await import('fflate');
  const output = await new ProductionService(repo, root).export(p.id); const chunks: Buffer[] = [];
  for await (const chunk of output.stream) chunks.push(Buffer.from(chunk));
  const files = unzipSync(Buffer.concat(chunks)); const manifest = JSON.parse(Buffer.from(files['manifest.json']).toString());
  const record = manifest.entries.find((e: any) => e.id === `portrait-request:${job.id}`);
  expect(record.content.reference.sha256).toBe(referenceUsed.sha256); expect(record.content.editInstruction).toBe(request.editInstruction);
  expect(manifest.entries.filter((e: any) => e.file && e.availability === 'available')).toHaveLength(2);
  expect(JSON.stringify(record)).not.toContain(root); expect(JSON.stringify(record)).not.toContain('data:image');
});

test('rejects a reference from another identity, project, empty version or tampered image before portrait submission', async () => {
  let calls = 0; const { service, repo, p, lib, c, look } = await setup({ simulated: true, validatePortraitReference: async () => ({}), portrait: async () => { calls++; } });
  const otherProject = repo.createProject('其他故事', 2);
  let other = repo.characters.createCharacter(otherProject.id, 0, { name: '王伯', description: '其他身份' });
  other = repo.characters.createLook(otherProject.id, other.revision, other.characters[0].id, { name: '其他造型', description: '白发' });
  const foreign = other.characters[0].looks[0];
  const request = { revision: lib.revision, characterId: c.id, lookId: look.id, requestId: 'bad-ref', acceptCost: true };
  await expect(service.generate(p.id, { ...request, reference: { lookId: foreign.id, lookVersionId: foreign.selectedVersionId } })).rejects.toThrow(/参考|角色/);
  await expect(service.generate(p.id, { ...request, reference: { lookId: look.id, lookVersionId: look.selectedVersionId } })).rejects.toThrow(/参考图|图片/);
  let next = await service.upload(p.id, lib.revision, c.id, look.id, await picture(), 'image/png');
  const source = next.characters[0].looks[0].versions.at(-1)!;
  next = repo.characters.createCharacter(p.id, next.revision, { name: '路人', description: '另一角色' });
  const stranger = next.characters[1]; next = repo.characters.createLook(p.id, next.revision, stranger.id, { name: '常服', description: '白衣' });
  const strangerLook = next.characters[1].looks[0];
  await expect(service.generate(p.id, { ...request, revision: next.revision, characterId: stranger.id, lookId: strangerLook.id, reference: { lookId: look.id, lookVersionId: source.id } })).rejects.toThrow(/参考|角色/);
  const asset = service.image(p.id, source.imageAssetId!); await writeFile(asset.path, Buffer.alloc(asset.asset.bytes, 0));
  await expect(service.generate(p.id, { ...request, revision: next.revision, reference: { lookId: look.id, lookVersionId: source.id } })).rejects.toThrow(/校验|摘要/);
  expect(calls).toBe(0); expect(service.jobs.list(p.id)).toHaveLength(0);
});

test('reference preflight rechecks library revision after awaiting provider capabilities', async () => {
  let calls = 0; let release!: () => void; let entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }); const ready = new Promise<void>(resolve => { entered = resolve; });
  const { service, repo, p, lib, c, look } = await setup({ simulated: true, validatePortraitReference: async () => { entered(); await gate; }, portrait: async () => { calls++; } });
  const next = await service.upload(p.id, lib.revision, c.id, look.id, await picture(), 'image/png');
  const source = next.characters[0].looks[0].versions.at(-1)!;
  const pending = service.generate(p.id, { revision: next.revision, characterId: c.id, lookId: look.id, requestId: 'racing', acceptCost: true, reference: { lookId: look.id, lookVersionId: source.id } });
  await ready; repo.characters.updateLook(p.id, next.revision, c.id, look.id, { description: '其他窗口修改' }); release();
  await expect(pending).rejects.toThrow(/版本/); expect(calls).toBe(0);
});

test('an adapter without reference capability never silently falls back to text-only generation', async () => {
  let calls = 0; const { service, p, lib, c, look } = await setup({ simulated: true, portrait: async () => { calls++; } });
  const next = await service.upload(p.id, lib.revision, c.id, look.id, await picture(), 'image/png'); const source = next.characters[0].looks[0].versions.at(-1)!;
  await expect(service.generate(p.id, { revision: next.revision, characterId: c.id, lookId: look.id, requestId: 'unsupported', acceptCost: true, reference: { lookId: look.id, lookVersionId: source.id } })).rejects.toThrow(/参考|支持/);
  expect(calls).toBe(0);
});


test('a competing unknown submission during reference preflight blocks a new paid request', async () => {
  let calls = 0; const { service, repo, p, lib, c, look } = await setup({ simulated: false, validatePortraitReference: async () => {
    service.jobs.create({ id: 'competitor', projectId: p.id, characterId: c.id, lookId: look.id, lookVersionId: look.selectedVersionId, libraryRevision: lib.revision, inputHash: 'fixture', status: 'unknown', assetId: null, error: 'unknown', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  }, portrait: async () => { calls++; throw new UncertainSubmission(); } });
  const next = await service.upload(p.id, lib.revision, c.id, look.id, await picture(), 'image/png'); const source = next.characters[0].looks[0].versions.at(-1)!;
  await expect(service.generate(p.id, { revision: next.revision, characterId: c.id, lookId: look.id, requestId: 'after-unknown', acceptCost: true, reference: { lookId: look.id, lookVersionId: source.id } })).rejects.toThrow(/未知|核实/);
  expect(calls).toBe(0);
});
