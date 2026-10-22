import { createAssistantMessageEventStream, getDeclaredTools, type AssistantMessage, type JsonObject } from '@earendil-works/pi-ai';
import type { DirectorStream } from '../src/director/pi-director.js';

/** Test fixture only: Pi still executes its real agent/tool loop; no network. */
export function scriptedStream(value: unknown, seen: string[][] = []): DirectorStream {
  let count = 0;
  return (_model, context) => {
    seen.push((context.tools ?? getDeclaredTools(context.messages)).map(t => t.name));
    const first = count++ === 0;
    const message: AssistantMessage = { role: 'assistant', api: 'openai-completions', provider: 'story-deepseek', model: 'deepseek-chat',
      content: first ? [{ type: 'toolCall', id: 'plan-1', name: 'propose_storyboard', arguments: value as JsonObject }] : [{ type: 'text', text: '分镜已提交，等待用户确认。' }],
      stopReason: first ? 'toolUse' : 'stop', timestamp: Date.now(),
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    const stream = createAssistantMessageEventStream(); queueMicrotask(() => { stream.push({ type: 'start', partial: message }); stream.push({ type: 'done', reason: message.stopReason === 'toolUse' ? 'toolUse' : 'stop', message }); stream.end(); }); return stream;
  };
}
