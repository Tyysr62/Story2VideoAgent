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
