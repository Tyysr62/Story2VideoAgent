import { test, expect, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, stat, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockMedia, FfmpegComposer, runFfmpeg, inspectMedia } from '../src/media/ffmpeg.js';
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

async function tone(root: string, name: string, hz: number, audioSeconds = 1) {
  const path = join(root, name);
  await runFfmpeg(['-f', 'lavfi', '-i', 'color=c=blue:s=160x90:r=24:d=1', '-f', 'lavfi', '-i', `sine=frequency=${hz}:duration=${audioSeconds}:sample_rate=44100`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', path]); return path;
}
async function audioSample(root: string, path: string, at: number) {
  const out = join(root, `sample-${at}-${Date.now()}.pcm`);
  await runFfmpeg(['-ss', String(at), '-i', path, '-t', '0.15', '-map', '0:a:0', '-ac', '1', '-ar', '8000', '-f', 's16le', out]);
  const data = await readFile(out); let sum = 0, crossings = 0, previous = 0;
  for (let i = 0; i + 1 < data.length; i += 2) { const value = data.readInt16LE(i); sum += Math.abs(value); if (value > 0 && previous <= 0) crossings++; previous = value; }
  return { amplitude: sum / (data.length / 2), hz: crossings / (data.length / 2 / 8000) };
}
test('keeps sound and clip order across mixed voiced and silent inputs without modifying sources', async () => {
  const root = await dir(); const a = await tone(root, 'a.mp4', 440), b = join(root, 'silent.mp4'), c = await tone(root, 'c.mp4', 880);
  await new MockMedia().video(board(1).shots[0], b); const source = await readFile(a); const out = join(root, 'mixed.mp4');
  await new FfmpegComposer().compose([a, b, c], out);
  const first = await audioSample(root, out, 0.3), middle = await audioSample(root, out, 1.3), last = await audioSample(root, out, 2.3);
  expect(first.amplitude).toBeGreaterThan(100); expect(first.hz).toBeCloseTo(440, -1); expect(middle.amplitude).toBeLessThan(5); expect(last.hz).toBeCloseTo(880, -1);
  expect(await readFile(a)).toEqual(source); expect((await readdir(root)).some(n => n.startsWith('.compose-'))).toBe(false);
  expect((await inspectMedia(out)).duration).toBeCloseTo(3, 1);
});
test('pads short soundtracks to the full video and explicitly mutes a shot in the final composition', async () => {
  const root = await dir(); const a = await tone(root, 'short.mp4', 440, 0.2), b = await tone(root, 'muted.mp4', 880); const out = join(root, 'padded.mp4');
  await new FfmpegComposer().compose([a, b], out, { mute: [false, true] });
  expect((await audioSample(root, out, 0.05)).amplitude).toBeGreaterThan(100);
  expect((await audioSample(root, out, 0.6)).amplitude).toBeLessThan(5);
  expect((await audioSample(root, out, 1.4)).amplitude).toBeLessThan(5);
  expect((await audioSample(root, b, 0.4)).amplitude).toBeGreaterThan(100);
  expect((await inspectMedia(out)).duration).toBeCloseTo(2, 1);
});

test('preserves a delayed soundtrack instead of shifting speech to the beginning of the shot', async () => {
  const root = await dir(); const input = join(root, 'delayed.mp4'), output = join(root, 'delayed-final.mp4');
  await runFfmpeg(['-f', 'lavfi', '-i', 'color=c=blue:s=160x90:r=24:d=1', '-itsoffset', '0.5', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.5:sample_rate=48000', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', input]);
  await new FfmpegComposer().compose([input], output);
  expect((await audioSample(root, output, 0.1)).amplitude).toBeLessThan(5);
  expect((await audioSample(root, output, 0.65)).amplitude).toBeGreaterThan(100);
  expect((await inspectMedia(output)).duration).toBeCloseTo(1, 1);
});
