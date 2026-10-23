import { test, expect, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import sharp from 'sharp';
import { Repository } from '../src/storage/repository.js';
import { CharacterService } from '../src/characters/service.js';
import { M2Service } from '../src/production/m2.js';
import { MockMedia, FfmpegComposer } from '../src/media/ffmpeg.js';
import { board } from './fixtures.js';
import { UncertainSubmission } from '../src/media/openrouter.js';

const close: (() => Promise<void>)[] = []; afterEach(async () => { for (const f of close.splice(0)) await f(); });
async function setup(fail = false) {
  const root = await mkdtemp(join(tmpdir(), 'story-m2-')); const repo = new Repository(join(root, 'app.db')); const mock = new MockMedia(); let calls = 0;
  const backend = { ...mock, simulated: true, generationConfig: (kind: string) => ({ model: `fixture-${kind}`, parameters: { resolution: '1K' } }),
    validateKeyframe: async () => ({ provider: 'fixture' }),
    keyframe: async (input: any, output: string) => { calls++; if (fail) throw new UncertainSubmission(); await mock.image({ ...board(1).shots[0], imagePrompt: input.prompt }, output); },
    image: mock.image.bind(mock), video: mock.video.bind(mock),
  };
  const p = repo.createProject('旧信重逢', 2); repo.saveStoryboard(p.id, 0, board(2), true);
  const c = repo.characters.snapshot(p.id).characters[0]; const look = c.looks[0];
  const portrait = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#5890ab' } }).png().toBuffer();
  const chars = new CharacterService(repo, root, { simulated: true, portrait: async () => {} });
  await chars.upload(p.id, repo.characters.snapshot(p.id).revision, c.id, look.id, portrait, 'image/png');
  const b = repo.getProject(p.id).storyboard!; const v = repo.characters.snapshot(p.id).characters[0].looks[0].selectedVersionId;
  b.shots.forEach(s => s.characterRefs![0].lookVersionId = v); repo.saveStoryboard(p.id, 1, b); repo.characters.approve(p.id, repo.characters.snapshot(p.id).revision);
  const service = new M2Service(repo, root, backend, new FfmpegComposer());
  close.push(async () => { await service.idle(); repo.close(); await rm(root, { recursive: true, force: true }); });
  return { root, repo, service, id: p.id, calls: () => calls, backend };
}
test('keyframes use role images, keep every candidate and prompt, and reject stale group approval', async () => {
  const { repo, service, id, calls } = await setup();
  const input = service.compile(id, 'shot-1'); expect(input.references).toHaveLength(1); expect(input.prompt).toContain('参考图 1');
  await service.frames(id, { revision: 2, shotIds: ['shot-1', 'shot-2'], requestId: 'first', acceptCost: true });
  expect(calls()).toBe(2); const first = service.view(id); expect(first.shots.every((s: any) => s.current)).toBe(true);
  await service.frames(id, { revision: 2, shotIds: ['shot-1', 'shot-2'], requestId: 'first', acceptCost: true }); expect(calls()).toBe(2);
  await expect(service.frames(id, { revision: 2, shotIds: ['shot-1'], requestId: 'first', acceptCost: true })).rejects.toThrow(/请求编号/);
  await service.approve(id, 2, first.manifestHash); expect(service.view(id).approved).toBe(true);
  await service.frames(id, { revision: 2, shotIds: ['shot-1'], requestId: 'redo', acceptCost: true, force: true });
  expect(calls()).toBe(3); expect(service.view(id).approved).toBe(false); expect(repo.production.list(id).filter(e => e.kind === 'keyframe' && e.status === 'succeeded')).toHaveLength(3);
  await expect(service.approve(id, 2, first.manifestHash)).rejects.toThrow(/清单|过期/);
  const b = repo.getProject(id).storyboard!; b.shots[0].imagePrompt = '修改构图'; repo.saveStoryboard(id, 2, b);
  expect(service.view(id).shots.map((s: any) => s.current)).toEqual([false, true]);
});
test('unknown image submission retains input and blocks another POST for that same input', async () => {
  const { repo, service, id, calls } = await setup(true);
  await service.frames(id, { revision: 2, shotIds: ['shot-1'], requestId: 'unknown', acceptCost: true });
  expect(repo.production.list(id).find(e => e.kind === 'keyframe')).toMatchObject({ status: 'unknown' });
  await expect(service.frames(id, { revision: 2, shotIds: ['shot-1'], requestId: 'again', acceptCost: true })).rejects.toThrow(/未知|核实/); expect(calls()).toBe(1);
});
test('preflight rejects a missing role image before any generation', async () => {
  const { root, repo, service, id, calls } = await setup(); const asset = repo.characters.images(id)[0]; await rm(join(root, asset.path));
  await expect(service.frames(id, { revision: 2, shotIds: ['shot-1'], requestId: 'missing', acceptCost: true })).rejects.toThrow(/丢失/); expect(calls()).toBe(0);
});
