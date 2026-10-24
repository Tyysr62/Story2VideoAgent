import { expect, test, vi } from 'vitest';
import { MediaQueue, resolveConcurrency } from '../src/media/queue.js';

const deferred = () => { let release!: () => void; const promise = new Promise<void>(r => { release = r; }); return { promise, release }; };

test('shares bounded FIFO slots across batches, with independent image and video pools', async () => {
  const queue = new MediaQueue({ image: 2, video: 1 }); const gate = deferred(); const started: string[] = [];
  const work = (name: string) => async () => { started.push(name); await gate.promise; };
  const first = queue.batch('image', [1, 2, 3], n => work(`a${n}`)());
  const second = queue.batch('image', [1, 2], n => work(`b${n}`)());
  const video = queue.run('video', work('video'));
  try { await vi.waitFor(() => expect(started).toEqual(['a1', 'a2', 'video'])); }
  finally { gate.release(); await Promise.all([first, second, video]); }
  expect(started.filter(n => n !== 'video')).toEqual(['a1', 'a2', 'a3', 'b1', 'b2']);
});

test('a failed item skips queued work but drains in-flight work before completing', async () => {
  const queue = new MediaQueue({ image: 2, video: 2 }); const gate = deferred(); const started: number[] = []; let settled = false;
  const result = queue.batch('image', [1, 2, 3, 4], async n => { started.push(n); if (n === 1) return false; await gate.promise; }).then(value => { settled = true; return value; });
  try { await vi.waitFor(() => expect(started).toEqual([1, 2])); expect(settled).toBe(false); }
  finally { gate.release(); }
  expect(await result).toBe(false); expect(started).toEqual([1, 2]);
  expect(await queue.batch('image', [5], async n => { started.push(n); })).toBe(true);
});

test('unexpected errors also drain active work before rejecting and release every slot', async () => {
  const queue = new MediaQueue({ image: 2, video: 1 }); const gate = deferred(); let finished = false;
  const result = queue.batch('video', [1, 2], async () => { throw Error('broken'); });
  await expect(result).rejects.toThrow('broken');
  const draining = queue.batch('image', [1, 2, 3], async n => { if (n === 1) throw Error('disk'); await gate.promise; finished = true; });
  const assertion = expect(draining).rejects.toThrow('disk');
  await Promise.resolve(); expect(finished).toBe(false); gate.release(); await assertion; expect(finished).toBe(true);
  await expect(queue.run('image', async () => 42)).resolves.toBe(42);
});

test('validates configurable limits and supplies bounded defaults', () => {
  expect(resolveConcurrency({})).toEqual({ image: 3, video: 3 });
  expect(resolveConcurrency({ IMAGE_CONCURRENCY: '1', VIDEO_CONCURRENCY: '8' })).toEqual({ image: 1, video: 8 });
  for (const value of ['0', '9', '-1', '1.5', 'NaN', '3oops', '']) expect(() => resolveConcurrency({ IMAGE_CONCURRENCY: value })).toThrow(/IMAGE_CONCURRENCY/);
  expect(() => new MediaQueue({ image: 0, video: 2 })).toThrow();
});
