import ffmpegPath from 'ffmpeg-static';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';
import type { Storyboard } from '../domain/storyboard.js';

export interface MediaBackend {
  readonly simulated: boolean;
  image(shot: Storyboard['shots'][number], output: string, task?: TaskContext): Promise<void>;
  video(shot: Storyboard['shots'][number], output: string, task?: TaskContext): Promise<void>;
}
export interface TaskContext { providerTaskId?: string; persistTaskId(id: string): void; }
export interface Composer { compose(inputs: string[], output: string): Promise<void>; }
export function runFfmpeg(args: string[], timeoutMs = 120000): Promise<void> {
  const executable = process.env.FFMPEG_PATH || ffmpegPath;
  if (!executable) return Promise.reject(new Error('FFmpeg 可执行文件不可用'));
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = ''; child.stderr.on('data', c => { stderr = (stderr + c.toString()).slice(-4000); });
    const timer = setTimeout(() => { child.kill(); reject(new Error('FFmpeg 执行超时')); }, timeoutMs);
    child.on('error', () => { clearTimeout(timer); reject(new Error('FFmpeg 无法启动，请检查安装')); });
    child.on('close', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`FFmpeg 处理失败 (${code}): ${stderr.slice(-500)}`)); });
  });
}
/** Offline testing adapter. Never selected automatically when a cloud key is missing. */
export class MockMedia implements MediaBackend {
  readonly simulated = true;
  private color(shot: Storyboard['shots'][number]) { return createHash('sha256').update(shot.id).digest('hex').slice(0, 6); }
  async image(shot: Storyboard['shots'][number], output: string) {
    await mkdir(dirname(output), { recursive: true });
    await runFfmpeg(['-f', 'lavfi', '-i', `color=c=0x${this.color(shot)}:s=640x360`, '-frames:v', '1', '-threads', '1', '-c:v', 'png', '-f', 'image2', output]);
  }
  generationConfig(kind: string) { return { model: `offline-${kind}`, parameters: { width: 640, height: 360, fixture: true } }; }
  async validateKeyframe(_references: number) { return { simulated: true }; }
  async keyframe(input: { prompt: string }, output: string) { return this.image({ id: createHash('sha256').update(input.prompt).digest('hex'), imagePrompt: input.prompt } as Storyboard['shots'][number], output); }
  async video(shot: Storyboard['shots'][number], output: string) {
    await mkdir(dirname(output), { recursive: true });
    await runFfmpeg(['-f', 'lavfi', '-i', `color=c=0x${this.color(shot)}:s=640x360:r=24`, '-t', String(shot.duration), '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', output]);
  }
}
export class FfmpegComposer implements Composer {
  async compose(inputs: string[], output: string) {
    if (!inputs.length || inputs.length > 20) throw new Error('合成需要1–20个片段');
    await mkdir(dirname(output), { recursive: true });
    const filters = inputs.map((_, i) => `[${i}:v]scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=24,format=yuv420p,setpts=PTS-STARTPTS[v${i}]`);
    filters.push(inputs.map((_, i) => `[v${i}]`).join('') + `concat=n=${inputs.length}:v=1:a=0[out]`);
    await runFfmpeg([...inputs.flatMap(x => ['-i', x]), '-filter_complex', filters.join(';'), '-map', '[out]', '-an', '-c:v', 'libx264', '-preset', 'ultrafast', '-movflags', '+faststart', output]);
  }
}
