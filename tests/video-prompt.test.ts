import { test, expect } from 'vitest';
import { compileVideoPrompt, VIDEO_PROMPT_VERSION } from '../src/media/video-prompt.js';
import { validateStoryboard } from '../src/domain/storyboard.js';
import { silentAudio } from '../src/domain/audio.js';
import { board } from './fixtures.js';

test('T2V describes identities and style, I2V prioritizes continuity and motion without image prompt repetition', () => {
  const b = validateStoryboard(board(1)); b.shots[0].imagePrompt = '不应传入视频的静态细节';
  const text = compileVideoPrompt(b, b.shots[0], 'text'); const frame = compileVideoPrompt(b, b.shots[0], 'first_frame');
  expect(text).toContain('橙色皮毛'); expect(text).toContain('手绘动画'); expect(text).toContain('中景缓推');
  expect(frame).toContain('首帧'); expect(frame).toContain('连续镜头'); expect(frame).not.toContain(b.shots[0].imagePrompt);
  expect(VIDEO_PROMPT_VERSION).toBeTruthy(); expect(text).toContain('完全静音');
});
test('compiles exact dialogue, separate off-screen narration and only the voices used by this shot', () => {
  const b = validateStoryboard(board(1)); b.audioProfile = { narratorVoice: '克制的普通话女声', characterVoices: [{ characterId: 'fox', description: '清澈少年声' }] };
  b.shots[0].audio = { ...silentAudio(), mode: 'speech', dialogue: [{ characterId: 'fox', text: '原来，你一直都记得。', delivery: '轻声', placement: 'on_screen' }], narration: { text: '那封信，他保存了四十年。', delivery: '缓慢' } };
  const prompt = compileVideoPrompt(b, b.shots[0], 'first_frame');
  expect(prompt).toContain('原来，你一直都记得。'); expect(prompt).toContain('那封信，他保存了四十年。'); expect(prompt).toContain('画外旁白'); expect(prompt).toContain('清澈少年声'); expect(prompt).toContain('克制的普通话女声'); expect(prompt).toContain('fox'); expect(prompt).toContain('不生成字幕');
  const stable = prompt; b.characters[0].name = '改名不会改动绑定'; expect(compileVideoPrompt(b, b.shots[0], 'first_frame')).toBe(stable);
  b.shots[0].audio.narration = null; const noNarration = compileVideoPrompt(b, b.shots[0], 'first_frame'); expect(noNarration).not.toContain('克制的普通话女声');
});
test('ambient permits sound effects but explicitly excludes unintended voices and music', () => {
  const b = validateStoryboard(board(1)); b.shots[0].audio = { ...silentAudio(), mode: 'ambient', ambience: '雨声', soundEffects: ['翻信声'] };
  const prompt = compileVideoPrompt(b, b.shots[0], 'first_frame'); expect(prompt).toContain('雨声'); expect(prompt).toContain('翻信声'); expect(prompt).toContain('无人声'); expect(prompt).toContain('无配乐');
});
