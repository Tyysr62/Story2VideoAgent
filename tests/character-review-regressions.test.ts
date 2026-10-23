import { test, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Repository } from '../src/storage/repository.js';
import { parseCharacterMentions } from '../src/domain/characters.js';
import { board } from './fixtures.js';

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach(fn => fn()));
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'role-review-')); const repo = new Repository(join(root, 'app.db')); const p = repo.createProject('回忆', 2);
  cleanups.push(() => { repo.close(); rmSync(root, { force: true, recursive: true }); });
  let lib = repo.characters.createCharacter(p.id, 0, { name: '陈伯', aliases: ['阿陈'], description: '教师' }); const c = lib.characters[0];
  const asset = repo.characters.saveImageAsset({ projectId: p.id, path: 'portraits/test.png', mime: 'image/png', bytes: 12, width: 2, height: 2, sha256: 'a'.repeat(64), source: 'upload', simulated: true });
  lib = repo.characters.createLook(p.id, lib.revision, c.id, { name: '青年', description: '黑发蓝衣', imageAssetId: asset.id }); const look = lib.characters[0].looks[0];
  const ref = { characterId: c.id, lookId: look.id, lookVersionId: look.selectedVersionId };
  const b = board(1); b.characters = [{ id: c.id, name: c.name, description: c.description }]; b.shots[0].characterIds = [c.id];
  return { repo, p, c, lib, look, ref, b };
}
test('rejects identity IDs without stable look bindings in V2', () => {
  const { repo, p, b } = setup(); expect(() => repo.saveStoryboard(p.id, 0, b)).toThrow(/绑定|引用/);
});
test('recognizes Chinese-adjacent mentions but ignores ordinary email addresses', () => {
  expect(parseCharacterMentions('他看到@陈伯·青年。')[0]?.name).toBe('陈伯');
  expect(parseCharacterMentions('他看到@不存在后离开')).toHaveLength(1);
  expect(parseCharacterMentions('请给 me@example.com 写信')).toEqual([]);
});
test('look rename and alias edits preserve saved bindings and visual approval', () => {
  const { repo, p, c, look, ref, b } = setup();
  repo.saveStoryboard(p.id, 0, { ...b, shots: [{ ...b.shots[0], description: '@阿陈·青年 回家', characterRefs: [ref] }] });
  let lib = repo.characters.approve(p.id, repo.characters.snapshot(p.id).revision); const manifest = lib.approval;
  lib = repo.characters.updateLook(p.id, lib.revision, c.id, look.id, { name: '年轻' });
  lib = repo.characters.updateCharacter(p.id, lib.revision, c.id, { aliases: [] });
  expect(lib.approval).toEqual(manifest); expect(() => repo.approve(p.id, 1)).not.toThrow();
});
test('look versions retain immutable identity/style/source/content snapshots', () => {
  const { repo, p, c, look, b, ref } = setup();
  repo.saveStoryboard(p.id, 0, { ...b, shots: [{ ...b.shots[0], characterRefs: [ref] }] });
  let lib = repo.characters.snapshot(p.id); lib = repo.characters.updateLook(p.id, lib.revision, c.id, look.id, { description: '白发灰衣' });
  const version = lib.characters[0].looks[0].versions.at(-1)!;
  expect(version).toMatchObject({ identityDescription: '教师', style: '手绘动画', source: 'upload' });
  expect(version).toHaveProperty('contentHash'); expect(version).toHaveProperty('identityHash');
});
test('a style change invalidates even an unapproved reviewer snapshot via library revision', () => {
  const { repo, p, b, ref } = setup();
  repo.saveStoryboard(p.id, 0, { ...b, shots: [{ ...b.shots[0], characterRefs: [ref] }] });
  const reviewed = repo.characters.snapshot(p.id);
  const next = structuredClone(repo.getProject(p.id).storyboard!); next.style = '新的三维写实风格';
  repo.saveStoryboard(p.id, 1, next);
  expect(() => repo.characters.approve(p.id, reviewed.revision)).toThrow(/版本/);
});
test('changing the default look does not retarget an already bound plain-name mention', () => {
  const { repo, p, c, look, ref, b } = setup();
  let lib = repo.characters.snapshot(p.id);
  lib = repo.characters.createLook(p.id, lib.revision, c.id, { name: '老年', default: true, description: '白发' });
  repo.saveStoryboard(p.id, 0, { ...b, shots: [{ ...b.shots[0], description: '@陈伯 回家', characterRefs: [ref] }] });
  expect(() => repo.characters.approve(p.id, repo.characters.snapshot(p.id).revision)).not.toThrow();
  expect(repo.getProject(p.id).storyboard!.shots[0].characterRefs![0].lookId).toBe(look.id);
});
