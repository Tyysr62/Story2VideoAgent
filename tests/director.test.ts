import { describe, test, expect } from 'vitest';
import { PiDirector } from '../src/director/pi-director.js';
import { scriptedStream, failedStream } from './scripted-model.js';
import { board } from './fixtures.js';
import type { CharacterLibrary } from '../src/domain/characters.js';
import { getDeclaredTools } from '@earendil-works/pi-ai';

describe('actual Pi SDK with an injected offline model transport', () => {
  test('exposes structured sound planning to Pi and normalizes missing legacy audio to silence', async () => {
    let system = ''; let toolSchema = '';
    const transport = scriptedStream(board(1));
    const d = new PiDirector({ apiKey: 'offline-test', stream: (model, context, options) => {
      toolSchema = JSON.stringify(context.tools ?? getDeclaredTools(context.messages)); return transport(model, context, options);
    } });
    const result = await d.plan('狐狸送信，不要强制旁白', undefined, undefined, trace => { system = trace.systemPrompt; });
    expect(system).toContain('旁白'); expect(system).toContain('画外'); expect(system).toContain('声音');
    expect(toolSchema).toContain('dialogue'); expect(toolSchema).toContain('narration'); expect(toolSchema).toContain('audioProfile');
    expect(result.shots[0].audio).toMatchObject({ mode: 'silent', dialogue: [], narration: null });
  });
  test('rejects newly invented identity IDs when the project has registered characters', async () => {
    const registered: CharacterLibrary = { revision: 1, approval: null, characters: [{ id: 'registered-fox', name: '小狐狸', aliases: [], description: '橙色狐狸', looks: [{ id: 'look-fox', name: '默认', selectedVersionId: 'version-fox', versions: [{ id: 'version-fox', description: '蓝围巾', imageAssetId: null, createdAt: 'now' }] }] }] };
    const director = new PiDirector({ apiKey: 'offline-test', stream: scriptedStream(board()) });
    await expect(director.plan('狐狸送信', undefined, registered)).rejects.toThrow(/角色|分镜/);
  });
  test.each([401, 402, 429, 500])('reports provider HTTP %i distinctly from invalid storyboard, without raw errors', async status => {
    const d = new PiDirector({ apiKey: 'do-not-expose', stream: failedStream(`${status} provider error containing do-not-expose and private response body`) });
    let error: Error | undefined; try { await d.plan('故事'); } catch (e) { error = e as Error; }
    expect(error?.message).toContain(String(status)); expect(error?.message).not.toContain('do-not-expose'); expect(error?.message).not.toContain('private response'); expect(error?.message).not.toContain('未提交有效分镜');
  });
  test.each(['is_management_key', 'is_provisioning_key'])('blocks OpenRouter %s before calling a model', async flag => {
    let calls = 0;
    const d = new PiDirector({ apiKey: 'fixture-admin', baseUrl: 'https://openrouter.ai/api/v1', fetcher: async () => Response.json({ data: { [flag]: true } }), stream: (...args) => { calls++; return scriptedStream(board())(...args); } });
    await expect(d.plan('故事')).rejects.toThrow(/管理密钥/); expect(calls).toBe(0);
  });
  test.each([
    { model: 'deepseek-flash', inputs: ['text', 'image'] },
    { model: 'deepseek/deepseek-v4.1-flash-1017', inputs: ['text', 'image'] },
    { model: 'deepseek-v4-pro', inputs: ['text'] },
  ])('declares verified input capabilities for $model to the real Pi runtime', async ({ model, inputs }) => {
    const fixture = scriptedStream(board()); const seen: string[][] = [];
    const d = new PiDirector({ apiKey: 'offline-test', model, stream: (runtimeModel, ...args) => {
      seen.push(runtimeModel.input); return fixture(runtimeModel, ...args);
    } });
    await d.plan('狐狸送信'); expect(seen.length).toBeGreaterThan(0); expect(seen[0]).toEqual(inputs);
  });
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
