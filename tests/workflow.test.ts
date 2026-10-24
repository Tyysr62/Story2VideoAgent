import { test, expect, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { Repository } from '../src/storage/repository.js';
import { Workflow } from '../src/workflow/workflow.js';
import { UncertainSubmission } from '../src/media/openrouter.js';
import { board } from './fixtures.js';
const resources: { root: string; r: Repository; w: Workflow }[] = [];
afterEach(async () => { for (const x of resources.splice(0)) { await x.w.idle(); x.r.close(); await rm(x.root, { recursive: true, force: true }); } });
async function setup(failure?: () => void) {
  const root = await mkdtemp(join(tmpdir(), 'story-flow-')); const r = new Repository(join(root, 'app.db')); let writes = 0;
  const output = async (_: unknown, path: string) => { failure?.(); writes++; await mkdir(dirname(path), { recursive: true }); await writeFile(path, 'media'); };
  const w = new Workflow(r, { plan: async () => board() }, { simulated: true, image: output, video: output }, { compose: async (_i, p) => output(null, p) }, root);
  resources.push({ root, r, w }); const p = r.createProject('狐狸送信'); r.saveStoryboard(p.id, 0, board()); return { root, r, w, id: p.id, writes: () => writes };
}
test('no execution before exact revision approval', async () => {
  const { w, r, id, writes } = await setup(); await expect(w.start(id, 1)).rejects.toThrow(/确认/); expect(writes()).toBe(0);
  r.approve(id, 1); await expect(w.start(id, 0)).rejects.toThrow(/版本/);
});
test('repeated start produces one job set and one final artifact', async () => {
  const { w, r, id, writes } = await setup(); r.approve(id, 1); await Promise.all([w.start(id, 1), w.start(id, 1)]); await w.idle(id);
  expect(r.getProject(id).status).toBe('ready'); expect(r.jobs(id)).toHaveLength(5); expect(r.artifacts(id)).toHaveLength(5); expect(writes()).toBe(5);
  await w.start(id, 1); await w.idle(id); expect(writes()).toBe(5);
});
test('known failure can be manually retried without discarding completed jobs', async () => {
  let fail = true; const { w, r, id } = await setup(() => { if (fail) { fail = false; throw Error('injected'); } });
  r.approve(id, 1); await w.start(id, 1); await w.idle(id); expect(r.getProject(id).status).toBe('failed');
  const failed = r.jobs(id).find(j => j.status === 'failed')!; expect(failed).toBeDefined();
  const retained = r.jobs(id).filter(j => j.status === 'succeeded');
  await w.start(id, 1); await w.idle(id); expect(r.getProject(id).status).toBe('ready'); expect(r.getJob(failed.id).attempts).toBe(2);
  for (const job of retained) expect(r.getJob(job.id)).toMatchObject({ artifactId: job.artifactId, attempts: job.attempts });
});
test('unknown submission does not get automatically submitted a second time', async () => {
  let attempts = 0; const { w, r, id } = await setup(() => { attempts++; throw new UncertainSubmission(); });
  r.approve(id, 1); await w.start(id, 1); await w.idle(id); expect(attempts).toBe(2);
  await expect(w.start(id, 1)).rejects.toThrow(/未知/); expect(attempts).toBe(2);
});
test('recovery completes persisted running work', async () => {
  const { w, r, id } = await setup(); r.approve(id, 1); r.updateProject(id, { status: 'generating' });
  const job = r.ensureJob({ projectId: id, revision: 1, kind: 'image', shotId: 'shot-1' }); r.updateJob(job.id, { status: 'running', attempts: 1 });
  await w.recover(); await w.idle(id); expect(r.getProject(id).status).toBe('ready'); expect(r.jobs(id)).toHaveLength(5);
});

test('saved cloud video ID can still be queried after three previous polling failures', async () => {
  const { w, r, id } = await setup(); r.approve(id, 1);
  const j = r.ensureJob({ projectId: id, revision: 1, kind: 'video', shotId: 'shot-1' });
  r.updateJob(j.id, { status: 'failed', attempts: 3, providerTaskId: 'paid-existing-id' });
  await w.start(id, 1); await w.idle(id);
  expect(r.getProject(id).status).toBe('ready'); expect(r.getJob(j.id).providerTaskId).toBe('paid-existing-id');
});

test('successful cloud image with a missing local artifact blocks another paid call', async () => {
  const { root, r, id } = await setup(); let images = 0;
  const w = new Workflow(r, { plan: async () => board() }, {
    simulated: false, image: async () => { images++; /* provider accepted; file disappeared before stat */ },
    video: async () => { throw Error('must not run'); },
  }, { compose: async () => { throw Error('must not run'); } }, root);
  r.approve(id, 1); await w.start(id, 1); await w.idle(id);
  expect(r.jobs(id).every(j => j.status === 'unknown')).toBe(true); expect(images).toBe(2);
  await expect(w.start(id, 1)).rejects.toThrow(/未知/); expect(images).toBe(2);
});

test('image metadata storage failure after paid output cannot resubmit the image', async () => {
  const { root, r, w: original, id, writes } = await setup();
  const w = new Workflow(r, { plan: async () => board() }, { ...original.media, simulated: false }, { compose: async () => {} }, root);
  const save = vi.spyOn(r, 'saveArtifact').mockImplementationOnce(() => { throw Error('metadata storage failure'); });
  r.approve(id, 1); await w.start(id, 1); await w.idle(id); save.mockRestore();
  expect(r.jobs(id).filter(j => j.status === 'unknown')).toHaveLength(1); expect(r.jobs(id).filter(j => j.status === 'succeeded')).toHaveLength(1);
  await expect(w.start(id, 1)).rejects.toThrow(/未知/); expect(writes()).toBe(2);
});

test('replanning revokes old approval and prevents old-version generation while model is pending', async () => {
  const { root, r, id, writes } = await setup(); r.approve(id, 1);
  let release!: (b: ReturnType<typeof board>) => void;
  const pending = new Promise<ReturnType<typeof board>>(resolve => { release = resolve; });
  const w = new Workflow(r, { plan: () => pending }, { simulated: true, image: async () => {}, video: async () => {} }, { compose: async () => {} }, root);
  const planning = w.plan(id, 1);
  let failure: unknown;
  try { await w.start(id, 1); } catch (e) { failure = e; }
  release(board(3)); await planning; await w.idle(id);
  expect(failure).toBeInstanceOf(Error); expect(writes()).toBe(0);
  expect(r.getProject(id)).toMatchObject({ status: 'awaiting_approval', revision: 2, approvedRevision: null, finalArtifactId: null });
  expect(r.jobs(id)).toHaveLength(0);
});

test('generation rechecks planning state after asynchronous capability validation', async () => {
  const { root, r, id } = await setup(); r.approve(id, 1);
  let releaseValidation!: () => void, releasePlan!: (b: ReturnType<typeof board>) => void;
  const validation = new Promise<void>(resolve => { releaseValidation = resolve; });
  const planning = new Promise<ReturnType<typeof board>>(resolve => { releasePlan = resolve; });
  const w = new Workflow(r, { plan: () => planning }, { simulated: true, validate: () => validation, image: async () => {}, video: async () => {} }, { compose: async () => {} }, root);
  const starting = w.start(id, 1); const planTask = w.plan(id, 1); releaseValidation();
  let failure: unknown; try { await starting; } catch (e) { failure = e; }
  releasePlan(board(3)); await planTask; await w.idle(id);
  expect(failure).toBeInstanceOf(Error); expect(r.jobs(id)).toHaveLength(0); expect(r.getProject(id).revision).toBe(2);
});

test('V1 independently generates three images and videos at a time and composes in story order', async () => {
  const { root, r, id } = await setup(); r.saveStoryboard(id, 1, board(4)); r.approve(id, 2);
  const started = { image: [] as string[], video: [] as string[] }; const releases: (() => void)[] = [];
  const gates = Array.from({ length: 8 }, () => new Promise<void>(resolve => { releases.push(resolve); }));
  const output = (kind: 'image' | 'video') => async (shot: ReturnType<typeof board>['shots'][number], path: string) => {
    started[kind].push(shot.id); await gates[Number(shot.id.slice(5)) - 1 + (kind === 'video' ? 4 : 0)]; await writeFile(path, kind);
  };
  const ordered: string[][] = [];
  const w = new Workflow(r, { plan: async () => board(4) }, { simulated: true, image: output('image'), video: output('video') }, { compose: async (inputs, path) => { ordered.push(inputs); await writeFile(path, 'final'); } }, root);
  await w.start(id, 2);
  try {
    await vi.waitFor(() => expect(started.image).toHaveLength(3)); releases[2]();
    await vi.waitFor(() => expect(started.image).toHaveLength(4)); releases.slice(0, 4).forEach(f => f());
    await vi.waitFor(() => expect(started.video).toHaveLength(3)); expect(ordered).toHaveLength(0); releases[6]();
    await vi.waitFor(() => expect(started.video).toHaveLength(4));
  } finally { releases.forEach(f => f()); await w.idle(id); }
  expect(ordered).toEqual([board(4).shots.map(s => join(root, r.artifacts(id).find(a => a.kind === 'video' && a.shotId === s.id)!.path))]);
  expect(r.getProject(id).status).toBe('ready');
});
