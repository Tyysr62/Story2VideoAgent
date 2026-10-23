import { test, expect } from 'vitest';
import { Repository } from '../src/storage/repository.js';
import { validateStoryboard } from '../src/domain/storyboard.js';
import { board } from './fixtures.js';

const spoken = () => ({ mode: 'speech', dialogue: [{ characterId: 'fox', text: '这封信，终于送到了。', delivery: '温柔', placement: 'on_screen' }], narration: null, ambience: '微风', soundEffects: ['纸张摩擦'], music: 'none' });
function input() { const b: any = board(); b.audioProfile = { narratorVoice: '温暖的普通话女声', characterVoices: [{ characterId: 'fox', description: '清澈、轻快的普通话声音' }] }; b.shots[0].audio = spoken(); return b; }

test('retains structured dialogue and project voice profiles without changing legacy boards', () => {
  expect(validateStoryboard(input())).toMatchObject(input());
  expect(validateStoryboard(board())).toEqual(board());
});
test.each(['silent', 'ambient'])('%s cannot accidentally contain speech', mode => {
  const b = input(); b.shots[0].audio.mode = mode; expect(() => validateStoryboard(b)).toThrow();
});
test('silence cannot contain environmental sound or effects', () => {
  const b = input(); b.shots[0].audio = { ...spoken(), mode: 'silent', dialogue: [], ambience: '雨声' }; expect(() => validateStoryboard(b)).toThrow();
});
test.each(['unknown', ''])('rejects invalid speaker %s', speaker => {
  const b = input(); b.shots[0].audio.dialogue[0].characterId = speaker; expect(() => validateStoryboard(b)).toThrow();
});
test('on-screen dialogue requires the character in the shot, off-screen dialogue does not', () => {
  const b = input(); b.shots[0].characterIds = []; expect(() => validateStoryboard(b)).toThrow();
  b.shots[0].audio.dialogue[0].placement = 'off_screen'; expect(validateStoryboard(b).shots[0]).toHaveProperty('audio');
});
test('speech needs content and text must not be empty', () => {
  const b = input(); b.shots[0].audio.dialogue[0].text = ' '; expect(() => validateStoryboard(b)).toThrow();
  b.shots[0].audio.dialogue = []; expect(() => validateStoryboard(b)).toThrow();
  b.shots[0].audio.narration = { text: '有些等待，值得一生。', delivery: '克制' }; expect(validateStoryboard(b).shots[0]).toHaveProperty('audio.narration.text', '有些等待，值得一生。');
});
test('voice profile references must exist and be unique', () => {
  const b = input(); b.audioProfile.characterVoices.push(b.audioProfile.characterVoices[0]); expect(() => validateStoryboard(b)).toThrow();
  b.audioProfile.characterVoices = [{ characterId: 'unknown', description: '低沉' }]; expect(() => validateStoryboard(b)).toThrow();
});
test('stores voice and script revisions immutably in production history', () => {
  const repo = new Repository(':memory:');
  try {
    const p = repo.createProject('狐狸送信'); repo.saveStoryboard(p.id, 0, input());
    const changed = input(); changed.shots[0].audio.dialogue[0].text = '下一站，是月亮。'; repo.saveStoryboard(p.id, 1, changed);
    const snapshots = repo.production.list(p.id).filter(e => e.kind === 'storyboard');
    expect((snapshots[0].content as any).shots[0].audio.dialogue[0].text).toBe('这封信，终于送到了。');
    expect(repo.getProject(p.id).storyboard?.shots[0]).toHaveProperty('audio.dialogue.0.text', '下一站，是月亮。');
  } finally { repo.close(); }
});

test('V2 rejects invented off-screen speakers even if the submitted character list includes them', () => {
  const repo = new Repository(':memory:');
  try {
    const p = repo.createProject('角色声音边界', 2); repo.saveStoryboard(p.id, 0, board(1), true);
    const b = repo.getProject(p.id).storyboard!; b.characters.push({ id: 'invented', name: '伪造角色', description: '不在角色库中' });
    b.shots[0].audio = { ...spoken(), mode: 'speech', dialogue: [{ characterId: 'invented', text: '画外声音', delivery: '', placement: 'off_screen' }] } as any;
    expect(() => repo.saveStoryboard(p.id, 1, b)).toThrow(/声音|台词|角色/);
  } finally { repo.close(); }
});

test('cannot delete an identity that is only referenced by off-screen dialogue', () => {
  const repo = new Repository(':memory:');
  try {
    const p = repo.createProject('画外角色', 2); repo.saveStoryboard(p.id, 0, board(1), true);
    const b = repo.getProject(p.id).storyboard!; b.shots[0].characterIds = []; b.shots[0].characterRefs = [];
    b.shots[0].audio = { ...spoken(), dialogue: [{ characterId: 'fox', text: '我在这里。', delivery: '', placement: 'off_screen' }] } as any; repo.saveStoryboard(p.id, 1, b);
    expect(() => repo.characters.deleteCharacter(p.id, repo.characters.snapshot(p.id).revision, 'fox')).toThrow(/引用/);
  } finally { repo.close(); }
});

test('voice profiles must be explicitly cleared and saved before deleting an otherwise unused identity', () => {
  const repo = new Repository(':memory:');
  try {
    const p = repo.createProject('闲置声音', 2); repo.saveStoryboard(p.id, 0, board(1), true);
    const b = repo.getProject(p.id).storyboard!; b.shots[0].characterIds = []; b.shots[0].characterRefs = [];
    b.audioProfile = { narratorVoice: '', characterVoices: [{ characterId: 'fox', description: '少年声' }] }; repo.saveStoryboard(p.id, 1, b);
    expect(() => repo.characters.deleteCharacter(p.id, repo.characters.snapshot(p.id).revision, 'fox')).toThrow(/声音设定/);
    b.audioProfile.characterVoices = []; repo.saveStoryboard(p.id, 2, b); repo.characters.deleteCharacter(p.id, repo.characters.snapshot(p.id).revision, 'fox');
    expect(() => repo.characters.approve(p.id, repo.characters.snapshot(p.id).revision)).not.toThrow();
  } finally { repo.close(); }
});
