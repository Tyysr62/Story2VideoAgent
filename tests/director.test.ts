import { describe, test, expect } from 'vitest';
import { PiDirector } from '../src/director/pi-director.js';
import { scriptedStream } from './scripted-model.js';
import { board } from './fixtures.js';

describe('actual Pi SDK with an injected offline model transport', () => {
  test.each([2, 7, 20])('accepts AI chosen %i shots', async n => {
    const tools: string[][] = [];
    const director = new PiDirector({ apiKey: 'offline-test', stream: scriptedStream(board(n), tools) });
    const result = await director.plan('一只狐狸给月亮送信'); expect(result.shots).toHaveLength(n);
    expect(tools[0]).toEqual(['propose_storyboard']);
  });
  test('never silently clips an oversized model plan', async () => {
    const d = new PiDirector({ apiKey: 'offline-test', stream: scriptedStream(board(21)) });
    await expect(d.plan('故事')).rejects.toThrow(/分镜|20/);
  });
  test('fails clearly without credentials rather than generating heuristic shots', async () => {
    const d = new PiDirector({ apiKey: '' }); await expect(d.plan('故事')).rejects.toThrow(/DEEPSEEK_API_KEY/);
  });
  test('ignores pre-aborted work', async () => {
    const d = new PiDirector({ apiKey: 'offline-test', stream: scriptedStream(board()) });
    await expect(d.plan('故事', AbortSignal.abort())).rejects.toThrow(/取消/);
  });
});
