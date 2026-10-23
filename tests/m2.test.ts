import { test, expect, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import sharp from 'sharp';
import { Repository } from '../src/storage/repository.js';
import { CharacterService } from '../src/characters/service.js';
import { M2Service, type M2Backend } from '../src/production/m2.js';
import { MockMedia, FfmpegComposer } from '../src/media/ffmpeg.js';
import { board } from './fixtures.js';
import { UncertainSubmission } from '../src/media/openrouter.js';
import { silentAudio } from '../src/domain/audio.js';

test('voice and dialogue edits reuse all keyframes and unrelated videos, archive actual compiled prompts and revoke approval', async () => {
  const { repo, service, id } = await setup();
  await service.frames(id, { revision: 2, shotIds: ['shot-1', 'shot-2'], requestId: 'frames-audio', acceptCost: true });
  await service.approve(id, 2, service.view(id).manifestHash);
  await service.videos(id, { revision: 2, shotIds: ['shot-1', 'shot-2'], requestId: 'video-silent', acceptCost: true, manifestHash: service.view(id).manifestHash });
  const b = repo.getProject(id).storyboard!;
  b.audioProfile = { narratorVoice: '温暖女声', characterVoices: [{ characterId: 'fox', description: '清澈少年声' }] };
  b.shots[0].audio = { ...silentAudio(), mode: 'speech', dialogue: [{ characterId: 'fox', text: '原来，你一直都记得。', delivery: '轻声', placement: 'on_screen' }] };
  repo.saveStoryboard(id, 2, b);
  expect(service.view(id).shots.map(s => s.current)).toEqual([true, true]);
  expect(service.view(id).shots.map(s => s.videoCurrent)).toEqual([false, true]); expect(service.view(id).approved).toBe(false);
  await service.approve(id, 3, service.view(id).manifestHash);
  await service.videos(id, { revision: 3, shotIds: ['shot-1', 'shot-2'], requestId: 'video-spoken', acceptCost: true, manifestHash: service.view(id).manifestHash });
  const videos = repo.production.list(id).filter(e => e.kind === 'video'); expect(videos).toHaveLength(3);
  expect(videos.at(-1)?.prompt).toContain('原来，你一直都记得。'); expect(videos.at(-1)?.prompt).toContain('清澈少年声');
  b.audioProfile.characterVoices[0].description = '低沉男声'; repo.saveStoryboard(id, 3, b);
  expect(service.view(id).shots.map(s => s.current)).toEqual([true, true]); expect(service.view(id).shots.map(s => s.videoCurrent)).toEqual([false, true]);
});

test('an older unfinished cloud task blocks a new submission after prompt compilation changes', async () => {
  const { repo, service, id } = await setup();
  await service.frames(id, { revision: 2, shotIds: ['shot-1', 'shot-2'], requestId: 'legacy-frames', acceptCost: true });
  await service.approve(id, 2, service.view(id).manifestHash);
  repo.production.create({ projectId: id, kind: 'video', shotId: 'shot-1', label: '上个版本的云任务', status: 'failed', inputHash: 'legacy-compiler-hash', providerTaskId: 'already-paid-old-task' });
  await expect(service.videos(id, { revision: 2, shotIds: ['shot-1'], requestId: 'changed-input', acceptCost: true, manifestHash: service.view(id).manifestHash })).rejects.toThrow(/旧版本云任务/);
});

const close: (() => Promise<void>)[] = []; afterEach(async () => { for (const f of close.splice(0)) await f(); });
async function setup(fail = false) {
  const root = await mkdtemp(join(tmpdir(), 'story-m2-')); const repo = new Repository(join(root, 'app.db')); const mock = new MockMedia(); let calls = 0;
  const backend: M2Backend = { ...mock, simulated: true, generationConfig: (kind: string) => ({ model: `fixture-${kind}`, parameters: { resolution: '1K' } }),
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

test('approved first frames drive selected videos, reuse valid clips, compose in order and remain exportable', async () => {
  const { root, repo, service, id, backend } = await setup();
  await service.frames(id, { revision: 2, shotIds: ['shot-1', 'shot-2'], requestId: 'frames', acceptCost: true });
  await service.approve(id, 2, service.view(id).manifestHash);
  const frames: string[] = []; const mock = new MockMedia();
  backend.video = async (shot, path, task) => { frames.push(task!.firstFrameUrl!); await mock.video(shot, path); };
  const transport = { configured: true, frame: async () => 'https://storage.example/first.png?signature=private-fixture' };
  const videos = new M2Service(repo, root, backend, new FfmpegComposer(), transport);
  await videos.videos(id, { revision: 2, shotIds: ['shot-1'], requestId: 'video-one', acceptCost: true, manifestHash: service.view(id).manifestHash });
  expect(repo.getProject(id).finalArtifactId).toBeNull(); expect(frames).toHaveLength(1);
  await videos.videos(id, { revision: 2, shotIds: ['shot-1', 'shot-2'], requestId: 'video-all', acceptCost: true, manifestHash: service.view(id).manifestHash });
  expect(frames).toHaveLength(2); expect(repo.getProject(id).status).toBe('ready'); expect(repo.getProject(id).finalArtifactId).toBeTruthy();
  expect(JSON.stringify(repo.production.list(id))).not.toContain('private-fixture');
  const before = service.view(id).manifestHash; const b = repo.getProject(id).storyboard!; b.shots[0].videoPrompt = '新运镜'; repo.saveStoryboard(id, 2, b);
  await expect(videos.videos(id, { revision: 3, shotIds: ['shot-1'], requestId: 'stale-video', acceptCost: true, manifestHash: before })).rejects.toThrow(/确认|清单/); expect(frames).toHaveLength(2);
});

test('missing object storage blocks a real billed video before any POST', async () => {
  const { root, repo, service, id, backend } = await setup(); await service.frames(id, { revision: 2, shotIds: ['shot-1', 'shot-2'], requestId: 'frames', acceptCost: true }); await service.approve(id, 2, service.view(id).manifestHash);
  let calls = 0; const real = { ...backend, simulated: false, video: async () => { calls++; } };
  const videos = new M2Service(repo, root, real, new FfmpegComposer());
  await expect(videos.videos(id, { revision: 2, shotIds: ['shot-1'], requestId: 'no-store', acceptCost: true, manifestHash: videos.view(id).manifestHash })).rejects.toThrow(/对象存储/); expect(calls).toBe(0);
});

test('video polling resumes the saved cloud ID after interruption without uploading or submitting again', async () => {
  const { root, repo, service, id, backend } = await setup(); await service.frames(id, { revision: 2, shotIds: ['shot-1', 'shot-2'], requestId: 'frames', acceptCost: true }); await service.approve(id, 2, service.view(id).manifestHash);
  let submits = 0; let fail = true; const mock = new MockMedia();
  backend.video = async (shot, output, task) => { if (!task!.providerTaskId) { submits++; task!.persistTaskId('cloud-saved'); } if (fail) { fail = false; throw Error('poll timeout'); } await mock.video(shot, output); };
  const videos = new M2Service(repo, root, backend, new FfmpegComposer()); const manifestHash = videos.view(id).manifestHash;
  await videos.videos(id, { revision: 2, shotIds: ['shot-1'], requestId: 'first', acceptCost: true, manifestHash });
  await videos.recover(); await videos.videos(id, { revision: 2, shotIds: ['shot-1'], requestId: 'resume', acceptCost: true, manifestHash });
  expect(submits).toBe(1); expect(repo.production.list(id).filter(e => e.kind === 'video')).toHaveLength(1); expect(videos.view(id).shots[0].videoCurrent).toBe(true);
});

test('renaming display labels does not change the actual visual prompt or its fingerprint', async () => {
  const { repo, service, id } = await setup(); const before = service.compile(id, 'shot-1'); const lib = repo.characters.snapshot(id); const c = lib.characters[0];
  repo.characters.updateLook(id, lib.revision, c.id, c.looks[0].id, { name: '青年造型' });
  const after = service.compile(id, 'shot-1'); expect(after.hash).toBe(before.hash); expect(after.prompt).toBe(before.prompt);
});

test('interruption recovers already-written bytes into the production library without a new request', async () => {
  const { root, repo, service, id, calls } = await setup();
  const path = `production/${id}/interrupted.image`; await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), 'already-produced-bytes');
  repo.production.create({ projectId: id, kind: 'keyframe', label: '中断首帧', status: 'running', prompt: '原始输入', outputPaths: [path] });
  repo.updateProject(id, { status: 'generating' }); await service.recover();
  expect(repo.production.list(id).some(e => e.file?.path === path)).toBe(true); expect(calls()).toBe(0);
});

test('a persisted cloud video can resume even if storage configuration is later unavailable', async () => {
  const { root, repo, service, id, backend } = await setup(); await service.frames(id, { revision: 2, shotIds: ['shot-1', 'shot-2'], requestId: 'frames', acceptCost: true }); await service.approve(id, 2, service.view(id).manifestHash);
  const mock = new MockMedia(); let submissions = 0; let pollFails = true;
  const real: M2Backend = { ...backend, simulated: false, validateImageToVideo: async () => {}, video: async (shot, path, task) => { if (!task!.providerTaskId) { submissions++; task!.persistTaskId('paid-existing'); } if (pollFails) { pollFails = false; throw Error('poll error'); } await mock.video(shot, path); } };
  const first = new M2Service(repo, root, real, new FfmpegComposer(), { configured: true, frame: async () => 'https://bucket.example/frame.png' }); const manifestHash = first.view(id).manifestHash;
  await first.videos(id, { revision: 2, shotIds: ['shot-1'], requestId: 'start', acceptCost: true, manifestHash });
  const restarted = new M2Service(repo, root, real, new FfmpegComposer());
  await restarted.videos(id, { revision: 2, shotIds: ['shot-1'], requestId: 'resume-without-upload', acceptCost: true, manifestHash });
  expect(submissions).toBe(1); expect(restarted.view(id).shots[0].videoCurrent).toBe(true);
});
