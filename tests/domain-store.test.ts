import { describe, test, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateStoryboard } from '../src/domain/storyboard.js';
import { Repository } from '../src/storage/repository.js';
import { board } from './fixtures.js';

const roots: string[] = [];
afterEach(() => { for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true }); });
function db() { const p = mkdtempSync(join(tmpdir(), 'story-domain-')); roots.push(p); return join(p, 'app.db'); }

describe('storyboard boundary: AI decides count, execution enforces <=20', () => {
  test.each([1, 2, 7, 20])('accepts %i shots unchanged', n => expect(validateStoryboard(board(n)).shots).toHaveLength(n));
  test.each([0, 21])('rejects %i shots without truncation', n => expect(() => validateStoryboard(board(n))).toThrow());
  test('rejects duplicate shot IDs', () => { const b = board(); b.shots[1].id = b.shots[0].id; expect(() => validateStoryboard(b)).toThrow(); });
  test('rejects unknown character references', () => { const b = board(); b.shots[0].characterIds = ['unknown']; expect(() => validateStoryboard(b)).toThrow(); });
  test('rejects zero duration', () => { const b = board(); b.shots[0].duration = 0; expect(() => validateStoryboard(b)).toThrow(); });
});

describe('revision-aware persistent projects', () => {
  test('saves, approves, invalidates approval on edit and survives reopen', () => {
    const path = db(); let r = new Repository(path); const p = r.createProject('一只狐狸为月亮送信');
    const draft = r.saveStoryboard(p.id, 0, board(7)); expect(draft.revision).toBe(1);
    expect(r.approve(p.id, 1).approvedRevision).toBe(1);
    const edited = r.saveStoryboard(p.id, 1, board(2)); expect(edited.approvedRevision).toBeNull(); expect(edited.revision).toBe(2);
    r.close(); r = new Repository(path); expect(r.getProject(p.id).storyboard?.shots).toHaveLength(2);
    expect(r.events(p.id).map(e => e.type)).toEqual(['project.created', 'storyboard.updated', 'project.approved', 'storyboard.updated']); r.close();
  });
  test('stale edits and approval do not mutate current revision', () => {
    const r = new Repository(db()); const p = r.createProject('故事'); r.saveStoryboard(p.id, 0, board());
    expect(() => r.saveStoryboard(p.id, 0, board(20))).toThrow(/版本/); expect(() => r.approve(p.id, 0)).toThrow(/版本/);
    expect(r.getProject(p.id).storyboard?.shots).toHaveLength(2); r.close();
  });
  test('cannot approve an empty project or edit during generation', () => {
    const r = new Repository(db()); const p = r.createProject('故事'); expect(() => r.approve(p.id, 0)).toThrow();
    r.saveStoryboard(p.id, 0, board()); r.updateProject(p.id, { status: 'generating' });
    expect(() => r.saveStoryboard(p.id, 1, board())).toThrow(/生成/); r.close();
  });
  test('unique logical job is reused after process restart', () => {
    const path = db(); let r = new Repository(path); const p = r.createProject('故事');
    const input = { projectId: p.id, revision: 1, kind: 'video' as const, shotId: 's1' };
    const j = r.ensureJob(input); r.close(); r = new Repository(path);
    expect(r.ensureJob(input).id).toBe(j.id); expect(r.jobs(p.id)).toHaveLength(1); r.close();
  });
});
