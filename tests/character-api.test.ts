import { test, expect, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import sharp from 'sharp';
import { Repository } from '../src/storage/repository.js';
import { CharacterService } from '../src/characters/service.js';
import { Workflow } from '../src/workflow/workflow.js';
import { createApp } from '../src/server/app.js';
import { board } from './fixtures.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'character-api-')); const repo = new Repository(join(root, 'app.db')); let mediaCalls = 0;
  const output = async (_: unknown, path: string) => { mediaCalls++; await mkdir(dirname(path), { recursive: true }); await writeFile(path, 'media'); };
  const planner = { plan: async () => board(2) };
  const workflow = new Workflow(repo, planner, { simulated: true, image: output, video: output }, { compose: (i, p) => output(i, p) }, root);
  const characters = new CharacterService(repo, root, { simulated: true, portrait: async (_, path) => { await mkdir(dirname(path), { recursive: true }); await writeFile(path, await sharp({ create: { width: 64, height: 64, channels: 3, background: 'red' } }).png().toBuffer()); } });
  const app = await createApp({ repo, workflow, characters, dataRoot: root, publicConfig: { simulated: true } });
  cleanup.push(async () => { await characters.idle(); await workflow.idle(); await app.close(); repo.close(); await rm(root, { recursive: true, force: true }); });
  const call = async (method: 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload: Record<string, unknown>) => app.inject({ method, url: `/api${url}`, payload });
  return { app, repo, workflow, call, mediaCalls: () => mediaCalls };
}
test('V2 planning registers stable role drafts, supports upload/preview, binding and manifest approval', async () => {
  const { app, call, repo } = await setup();
  const p = (await call('POST', '/projects', { story: '狐狸送信' })).json(); expect(p.workflowVersion).toBe(2);
  const planned = await call('POST', `/projects/${p.id}/plan`, { revision: 0 }); expect(planned.statusCode).toBe(200);
  let detail = (await app.inject(`/api/projects/${p.id}`)).json(); let lib = detail.characterLibrary;
  expect(lib.characters[0].name).toBe('小狐狸'); const character = lib.characters[0]; const look = character.looks[0];
  const png = await sharp({ create: { width: 32, height: 32, channels: 3, background: 'blue' } }).png().toBuffer();
  const path = `/api/projects/${p.id}/characters/${character.id}/looks/${look.id}/image`;
  const upload = await app.inject({ method: 'PUT', url: path, headers: { 'content-type': 'image/png', 'x-library-revision': String(lib.revision) }, payload: png });
  expect(upload.statusCode).toBe(200); lib = upload.json(); const version = lib.characters[0].looks[0].versions.at(-1);
  expect((await app.inject(`/api/projects/${p.id}/character-images/${version.imageAssetId}`)).statusCode).toBe(200);
  const b = detail.project.storyboard; b.shots.forEach((shot: any) => { shot.characterRefs[0].lookVersionId = version.id; });
  expect((await call('PUT', `/projects/${p.id}/storyboard`, { revision: 1, storyboard: b })).statusCode).toBe(200);
  expect((await call('POST', `/projects/${p.id}/characters/approve`, { revision: lib.revision })).json().approval).not.toBeNull();
  const renamed = await call('PATCH', `/projects/${p.id}/characters/${character.id}`, { revision: lib.revision, name: '狐狸邮差' });
  expect(renamed.json().approval).not.toBeNull(); expect(renamed.json().characters[0].aliases).toContain('小狐狸');
  expect(repo.getProject(p.id).storyboard!.shots[0].characterRefs![0].characterId).toBe(character.id);
  expect(JSON.stringify(detail)).not.toMatch(/apiKey|Bearer/);
});
test('V2 video is blocked server-side, and a legacy upgrade retains old outputs without starting media', async () => {
  const { call, repo, workflow, mediaCalls } = await setup();
  const old = repo.createProject('无人景物'); let b = board(1); b.characters = []; b.shots[0].characterIds = [];
  repo.saveStoryboard(old.id, 0, b); repo.approve(old.id, 1); repo.updateProject(old.id, { finalArtifactId: 'old-output' });
  const upgrade = await call('POST', `/projects/${old.id}/enable-v2`, { revision: 1 }); expect(upgrade.statusCode).toBe(200);
  expect(upgrade.json().workflowVersion).toBe(2); expect(upgrade.json().approvedRevision).toBeNull(); expect(upgrade.json().finalArtifactId).toBe('old-output');
  expect((await call('POST', `/projects/${old.id}/generate`, { revision: 1 })).statusCode).toBe(409);
  await expect(workflow.start(old.id, 1)).rejects.toThrow(/M2|首帧/); expect(mediaCalls()).toBe(0);
});
test('rejects stale library writes, foreign images, invalid content and deleted referenced identities', async () => {
  const { app, call } = await setup(); const p = (await call('POST', '/projects', { story: '狐狸' })).json();
  await call('POST', `/projects/${p.id}/plan`, { revision: 0 }); const detail = (await app.inject(`/api/projects/${p.id}`)).json(); const lib = detail.characterLibrary; const c = lib.characters[0]; const l = c.looks[0];
  expect((await call('PATCH', `/projects/${p.id}/characters/${c.id}`, { revision: lib.revision - 1, name: '新名' })).statusCode).toBe(409);
  expect((await call('DELETE', `/projects/${p.id}/characters/${c.id}`, { revision: lib.revision })).statusCode).toBe(409);
  expect((await app.inject(`/api/projects/${p.id}/character-images/unknown`)).statusCode).toBe(404);
  expect((await app.inject({ method: 'PUT', url: `/api/projects/${p.id}/characters/${c.id}/looks/${l.id}/image`, headers: { 'content-type': 'image/png', 'x-library-revision': String(lib.revision) }, payload: Buffer.from('<svg/>') })).statusCode).toBe(400);
  expect((await call('POST', `/projects/${p.id}/characters/${c.id}/looks/${l.id}/portrait`, { revision: lib.revision, requestId: 'no-consent', acceptCost: false })).statusCode).toBe(409);
});
test('replanning passes registered identity context and does not create duplicate identities', async () => {
  const { call, repo, app } = await setup(); const p = (await call('POST', '/projects', { story: '狐狸' })).json();
  await call('POST', `/projects/${p.id}/plan`, { revision: 0 }); const original = repo.characters.snapshot(p.id).characters[0].id;
  expect((await call('POST', `/projects/${p.id}/plan`, { revision: 1 })).statusCode).toBe(200);
  expect(repo.characters.snapshot(p.id).characters.map(c => c.id)).toEqual([original]);
  expect((await app.inject(`/api/projects/${p.id}`)).json().project.revision).toBe(2);
});
