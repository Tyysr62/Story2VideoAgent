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
  await w.start(id, 1); await w.idle(id); expect(r.getProject(id).status).toBe('ready'); expect(r.jobs(id)[0].attempts).toBe(2);
});
test('unknown submission does not get automatically submitted a second time', async () => {
  let attempts = 0; const { w, r, id } = await setup(() => { attempts++; throw new UncertainSubmission(); });
  r.approve(id, 1); await w.start(id, 1); await w.idle(id); await expect(w.start(id, 1)).rejects.toThrow(/未知/); expect(attempts).toBe(1);
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
  expect(r.jobs(id)[0].status).toBe('unknown'); await expect(w.start(id, 1)).rejects.toThrow(/未知/); expect(images).toBe(1);
});

test('image metadata storage failure after paid output cannot resubmit the image', async () => {
  const { root, r, w: original, id, writes } = await setup();
  const w = new Workflow(r, { plan: async () => board() }, { ...original.media, simulated: false }, { compose: async () => {} }, root);
  const save = vi.spyOn(r, 'saveArtifact').mockImplementationOnce(() => { throw Error('metadata storage failure'); });
  r.approve(id, 1); await w.start(id, 1); await w.idle(id); save.mockRestore();
  expect(r.jobs(id)[0].status).toBe('unknown'); await expect(w.start(id, 1)).rejects.toThrow(/未知/); expect(writes()).toBe(1);
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
