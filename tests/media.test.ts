import { test, expect, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockMedia, FfmpegComposer, runFfmpeg } from '../src/media/ffmpeg.js';
import { board } from './fixtures.js';
const roots: string[] = [];
afterEach(async () => { for (const r of roots.splice(0)) await rm(r, { recursive: true, force: true }); });
async function dir() { const p = await mkdtemp(join(tmpdir(), 'story-media-')); roots.push(p); return p; }

test('test-only mock produces real PNG and decodable MP4, with no model installed', async () => {
  const root = await dir(); const m = new MockMedia(); const shot = board().shots[0];
  // Workflow deliberately uses a format-neutral extension for cloud PNG/JPEG/WebP.
  const png = join(root, 'image.image'), mp4 = join(root, 'clip.mp4');
  await m.image(shot, png); await m.video(shot, mp4);
  expect((await readFile(png)).subarray(1, 4).toString()).toBe('PNG'); expect((await stat(mp4)).size).toBeGreaterThan(500);
  await expect(runFfmpeg(['-i', mp4, '-f', 'null', '-'])).resolves.toBeUndefined();
});
test('composes ordered clips to one playable MP4', async () => {
  const root = await dir(); const m = new MockMedia(); const inputs = [join(root, 'a.mp4'), join(root, 'b.mp4')];
  for (let i = 0; i < 2; i++) await m.video(board().shots[i], inputs[i]);
  const out = join(root, 'final.mp4'); await new FfmpegComposer().compose(inputs, out);
  await expect(runFfmpeg(['-i', out, '-f', 'null', '-'])).resolves.toBeUndefined(); expect((await stat(out)).size).toBeGreaterThan(1500);
});
test('invalid input and empty composition fail clearly', async () => {
  const root = await dir(); await expect(runFfmpeg(['-i', join(root, 'missing.mp4'), '-f', 'null', '-'])).rejects.toThrow(/FFmpeg/);
  await expect(new FfmpegComposer().compose([], join(root, 'x.mp4'))).rejects.toThrow();
});
