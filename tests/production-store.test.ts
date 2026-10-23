import { test, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Repository } from '../src/storage/repository.js';
import { board } from './fixtures.js';

test('each saved storyboard preserves its own prompt history across edits and restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'production-history-')); const path = join(root, 'story.db'); let repo = new Repository(path);
  try {
    const p = repo.createProject('一叠旧信'); const b = board(1); b.shots[0].imagePrompt = '最初的场景'; repo.saveStoryboard(p.id, 0, b);
    b.shots[0].imagePrompt = '修改后的场景'; repo.saveStoryboard(p.id, 1, b);
    const history = repo.production.list(p.id).filter(e => e.kind === 'storyboard');
    expect(history).toHaveLength(2); expect(JSON.stringify(history[0].content)).toContain('最初的场景');
    expect(JSON.stringify(history[1].content)).toContain('修改后的场景');
    repo.close(); repo = new Repository(path);
    expect(repo.production.list(p.id).filter(e => e.kind === 'storyboard')).toHaveLength(2);
    expect(repo.production.list(p.id).filter(e => e.kind === 'prompt').map(e => e.prompt)).toContain('最初的场景');
  } finally { repo.close(); await rm(root, { recursive: true, force: true }); }
});

test('production inputs are immutable, results update explicitly, and projects cannot read each other', () => {
  const repo = new Repository(':memory:');
  try {
    const a = repo.createProject('A'); const b = repo.createProject('B');
    const entry = repo.production.create({ projectId: a.id, kind: 'image', label: '候选图', status: 'running', prompt: '原始 Prompt', parameters: { resolution: '1K' }, dependencies: [] });
    repo.production.update(a.id, entry.id, { status: 'failed', error: '模拟失败', prompt: '伪造输入' } as any);
    expect(repo.production.get(a.id, entry.id)).toMatchObject({ prompt: '原始 Prompt', status: 'failed', error: '模拟失败' });
    expect(() => repo.production.get(b.id, entry.id)).toThrow(/当前项目/);
    expect(repo.production.list(b.id).some(e => e.id === entry.id)).toBe(false);
  } finally { repo.close(); }
});

test('old artifacts are backfilled without fabricating prompts or duplicating on reopen', async () => {
  const root = await mkdtemp(join(tmpdir(), 'production-backfill-')); const path = join(root, 'story.db'); let repo = new Repository(path);
  try {
    const p = repo.createProject('旧故事'); repo.saveStoryboard(p.id, 0, board(1));
    repo.saveArtifact({ id: 'old-image', projectId: p.id, revision: 1, shotId: 'shot-1', kind: 'image', path: 'artifacts/old.png', mime: 'image/png', bytes: 8, sha256: 'legacy-sha', simulated: true, createdAt: new Date().toISOString() });
    repo.close(); const db = new DatabaseSync(path); db.exec('DROP TABLE production_entries'); db.close(); repo = new Repository(path);
    const entry = repo.production.list(p.id).find(e => e.file?.path === 'artifacts/old.png');
    expect(entry).toMatchObject({ legacy: true, prompt: null });
    const count = repo.production.list(p.id).length; repo.close(); repo = new Repository(path); expect(repo.production.list(p.id)).toHaveLength(count);
  } finally { repo.close(); await rm(root, { recursive: true, force: true }); }
});
