import ffmpegPath from 'ffmpeg-static';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { AppError, type Storyboard } from '../domain/storyboard.js';

export interface MediaBackend {
  readonly simulated: boolean;
  image(shot: Storyboard['shots'][number], output: string, task?: TaskContext): Promise<void>;
  video(shot: Storyboard['shots'][number], output: string, task?: TaskContext): Promise<void>;
}
export interface TaskContext { providerTaskId?: string; firstFrameUrl?: string; persistTaskId(id: string): void; }
export interface ComposeOptions { mute?: boolean[]; }
export interface Composer { compose(inputs: string[], output: string, options?: ComposeOptions): Promise<void>; }
export const COMPOSE_PARAMETERS = { version: 'audio-v2.1', width: 1280, height: 720, fps: 24, audio: 'aac', sampleRate: 48000, channels: 2 } as const;
export class MissingAudioTrack extends AppError { constructor() { super(502, '云端片段没有音轨，未满足分镜声音要求；原片已保留，请核实后手动重试，不会自动重新扣费'); } }
async function ffmpeg(args: string[], timeoutMs = 120000, level = 'error'): Promise<string> {
  const executable = process.env.FFMPEG_PATH || ffmpegPath;
  if (!executable) return Promise.reject(new Error('FFmpeg 可执行文件不可用'));
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ['-hide_banner', '-loglevel', level, '-y', ...args], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '', timedOut = false; child.stderr.on('data', c => { stderr = (stderr + c.toString()).slice(-64000); });
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
    child.on('error', () => { clearTimeout(timer); reject(new Error('FFmpeg 无法启动，请检查安装')); });
    child.on('close', code => { clearTimeout(timer); timedOut ? reject(new Error('FFmpeg 执行超时')) : code === 0 ? resolve(stderr) : reject(new Error(`FFmpeg 处理失败 (${code}): ${stderr.slice(-500)}`)); });
  });
}
export async function runFfmpeg(args: string[], timeoutMs = 120000): Promise<void> { await ffmpeg(args, timeoutMs); }
export async function inspectMedia(path: string): Promise<{ hasAudio: boolean; duration: number }> {
  const log = await ffmpeg(['-i', path, '-map', '0:v:0', '-frames:v', '1', '-an', '-f', 'null', '-'], 120000, 'info');
  const time = log.match(/Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/);
  return { hasAudio: /Stream #0:\d+[^\r\n]*Audio:/.test(log), duration: time ? Number(time[1]) * 3600 + Number(time[2]) * 60 + Number(time[3]) : 0 };
}
/** Offline testing adapter. Never selected automatically when a cloud key is missing. */
export class MockMedia implements MediaBackend {
  readonly simulated = true;
  private color(shot: Storyboard['shots'][number]) { return createHash('sha256').update(shot.id).digest('hex').slice(0, 6); }
  async image(shot: Storyboard['shots'][number], output: string) {
    await mkdir(dirname(output), { recursive: true });
    await runFfmpeg(['-f', 'lavfi', '-i', `color=c=0x${this.color(shot)}:s=640x360`, '-frames:v', '1', '-threads', '1', '-c:v', 'png', '-f', 'image2', output]);
  }
  generationConfig(kind: string) { return { model: `offline-${kind}`, parameters: kind === 'compose' ? { ...COMPOSE_PARAMETERS, fixture: true } : { width: 640, height: 360, fixture: true } }; }
  async validateKeyframe(_references: number) { return { simulated: true }; }
  async validateImageToVideo(_board: Storyboard) {}
  async keyframe(input: { prompt: string }, output: string) { return this.image({ id: createHash('sha256').update(input.prompt).digest('hex'), imagePrompt: input.prompt } as Storyboard['shots'][number], output); }
  async video(shot: Storyboard['shots'][number], output: string) {
    await mkdir(dirname(output), { recursive: true });
    const audible = shot.audio && shot.audio.mode !== 'silent';
    await runFfmpeg(['-f', 'lavfi', '-i', `color=c=0x${this.color(shot)}:s=640x360:r=24`, ...(audible ? ['-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=48000:duration=${shot.duration}`, '-c:a', 'aac'] : []), '-t', String(shot.duration), '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', output]);
  }
}
export class FfmpegComposer implements Composer {
  async compose(inputs: string[], output: string, options: ComposeOptions = {}) {
    if (!inputs.length || inputs.length > 20) throw new Error('合成需要1–20个片段');
    if (options.mute && options.mute.length !== inputs.length) throw new Error('音轨策略必须与片段数量一致');
    await mkdir(dirname(output), { recursive: true });
    const temporary = await mkdtemp(join(dirname(output), '.compose-'));
    try {
      const normalized: string[] = [];
      for (const [i, path] of inputs.entries()) {
        const hasAudio = !options.mute?.[i] && (await inspectMedia(path)).hasAudio;
        const target = join(temporary, `${i}.mp4`); normalized.push(target);
        await runFfmpeg(['-threads', '1', '-i', path, ...(!hasAudio ? ['-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo'] : []),
          '-map', '0:v:0', '-map', hasAudio ? '0:a:0' : '1:a:0',
          '-vf', 'scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=24,format=yuv420p,setpts=PTS-STARTPTS',
          '-af', 'aresample=48000,aformat=channel_layouts=stereo,asetpts=PTS-STARTPTS,apad',
          '-shortest', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '18', '-c:a', 'aac', '-b:a', '192k', target]);
      }
      const filters = normalized.flatMap((_, i) => [`[${i}:v]setpts=PTS-STARTPTS[v${i}]`, `[${i}:a]asetpts=PTS-STARTPTS[a${i}]`]);
      filters.push(normalized.map((_, i) => `[v${i}][a${i}]`).join('') + `concat=n=${inputs.length}:v=1:a=1[outv][outa]`);
      await runFfmpeg([...normalized.flatMap(path => ['-threads', '1', '-i', path]), '-filter_complex', filters.join(';'), '-map', '[outv]', '-map', '[outa]', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '18', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', output]);
    } finally { await rm(temporary, { recursive: true, force: true }); }
  }
}
