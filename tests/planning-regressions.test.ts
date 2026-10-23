import { afterEach, expect, test, vi } from 'vitest';
import { Repository } from '../src/storage/repository.js';
import { Workflow } from '../src/workflow/workflow.js';
import { board } from './fixtures.js';

const repos: Repository[] = [];
afterEach(() => { vi.restoreAllMocks(); repos.splice(0).forEach(r => r.close()); });
function setup(value = board(2)) {
  const repo = new Repository(':memory:'); repos.push(repo); const project = repo.createProject('一封旧信，回忆重逢，约一分钟', 2);
  const workflow = new Workflow(repo, { plan: async () => value }, { simulated: true, image: async () => {}, video: async () => {} }, { compose: async () => {} }, '.');
  return { repo, project, workflow };
}

test('V2 character label save rejection is actionable and preserves the exact rejected model output', async () => {
  const invalid = board(2); invalid.characters[0].name = '陈伯（老年）'; const { repo, project, workflow } = setup(invalid);
  await expect(workflow.plan(project.id, 0)).rejects.toThrow(/角色名称/);
  expect(repo.getProject(project.id)).toMatchObject({ revision: 0, status: 'failed', storyboard: null });
  expect(repo.characters.snapshot(project.id)).toMatchObject({ revision: 0, characters: [] });
  const output = repo.production.list(project.id).find(e => e.label === '导演分镜输出');
  expect(output).toMatchObject({ status: 'failed', content: invalid, error: expect.stringContaining('角色名称') });
  expect(repo.events(project.id).at(-1)?.data).toMatchObject({ message: expect.stringContaining('角色名称') });
});

test('accepted V2 output remains separate from the server-enriched saved storyboard', async () => {
  const raw = board(2); const { repo, project, workflow } = setup(raw);
  const saved = await workflow.plan(project.id, 0);
  expect(saved.storyboard?.shots[0].characterRefs).toHaveLength(1);
  const output = repo.production.list(project.id).find(e => e.label === '导演分镜输出');
  expect(output).toMatchObject({ status: 'succeeded', content: raw, outputId: `board:${project.id}:r1` });
  expect((output?.content as any).shots[0].characterRefs).toBeUndefined();
});

test('unexpected save failures retain the generated plan while hiding private exception text', async () => {
  const { repo, project, workflow } = setup(); vi.spyOn(repo, 'saveStoryboard').mockImplementationOnce(() => { throw Error('private database details sk-secret'); });
  await expect(workflow.plan(project.id, 0)).rejects.toThrow('分镜规划失败');
  const entries = repo.production.list(project.id);
  expect(entries.find(e => e.label === '导演分镜输出')).toMatchObject({ status: 'failed', content: board(2) });
  expect(JSON.stringify(entries)).not.toContain('sk-secret'); expect(JSON.stringify(repo.getProject(project.id))).not.toContain('private database');
});
