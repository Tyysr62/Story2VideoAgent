import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { AppError, type Storyboard } from '../domain/storyboard.js';
import type { MediaBackend, TaskContext } from './ffmpeg.js';

export const DEFAULT_VIDEO_MODEL = 'heygen/heygen-video-1';
export const DEFAULT_IMAGE_MODEL = 'qwen/qwen-image-2.1-turbo';
export const DEFAULT_IMAGE_RESOLUTION = '1K';
export class UncertainSubmission extends AppError { readonly uncertain = true; constructor() { super(409, '云端提交状态未知，已阻止自动重复提交；请先到 OpenRouter 核实，避免重复扣费'); } }
export class ProviderFailed extends AppError { readonly terminal = true; constructor() { super(502, 'OpenRouter 已确认生成失败，可确认后重新尝试'); } }
interface Options { apiKey: string; videoModel?: string; imageModel?: string; resolution?: string; imageResolution?: string; baseUrl?: string; fetcher?: typeof fetch; pollMs?: number; maxPolls?: number; diagnosticRoot?: string; }
interface Capabilities { id: string; supported_durations: number[]; supported_resolutions: string[]; supported_aspect_ratios: string[]; pricing_skus: Record<string, string>; }

export class OpenRouterMedia implements MediaBackend {
  readonly simulated = false;
  readonly videoModel: string; readonly imageModel: string; readonly resolution: string;
  private fetcher: typeof fetch; private base: string; private caps?: { value: Capabilities; at: number };
  constructor(private options: Options) {
    this.videoModel = options.videoModel || DEFAULT_VIDEO_MODEL; this.imageModel = options.imageModel || DEFAULT_IMAGE_MODEL;
    this.resolution = options.resolution || '480p'; this.fetcher = options.fetcher ?? fetch; this.base = (options.baseUrl || 'https://openrouter.ai/api/v1').replace(/\/$/, '');
  }
  private key() { if (!this.options.apiKey.trim()) throw new AppError(503, '请在 .env.local 配置 OPENROUTER_API_KEY'); }
  private headers() { return { Authorization: `Bearer ${this.options.apiKey}`, 'Content-Type': 'application/json', 'X-Title': 'Story Agent' }; }
  private async json(path: string, body?: unknown): Promise<any> {
    if (body) this.key();
    let response: Response;
    try { response = await this.fetcher(`${this.base}${path}`, { method: body ? 'POST' : 'GET', headers: this.headers(), ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(body && path === '/images' ? 180000 : 30000), redirect: 'error' }); }
    catch { if (body) throw new UncertainSubmission(); throw new AppError(502, 'OpenRouter 查询失败，请检查网络后重试'); }
    if (!response.ok) {
      const diagnosticId = await this.recordError(response, path);
      if (body && response.status >= 500) throw new UncertainSubmission();
      const reason = response.status === 400 ? '请求参数或上游校验未通过' : response.status === 402 ? '账户余额或密钥额度不足' : [401, 403].includes(response.status) ? '模型调用认证或访问权限失败' : response.status === 429 ? '请求受限，请稍后重试' : '请求失败，请检查模型服务';
      throw new AppError(502, `OpenRouter 返回 HTTP ${response.status}：${reason}${diagnosticId ? `（诊断编号 ${diagnosticId}）` : ''}`);
    }
    try { return await response.json(); } catch { if (body) throw new UncertainSubmission(); throw new AppError(502, 'OpenRouter 返回无效响应'); }
  }
  private async recordError(response: Response, path: string): Promise<string | null> {
    if (!this.options.diagnosticRoot) return null;
    try {
      const reader = response.body?.getReader(); const chunks: Uint8Array[] = []; let size = 0;
      if (reader) { try { while (size < 65536) { const item = await reader.read(); if (item.done) break; const kept = item.value.subarray(0, 65536 - size); chunks.push(kept); size += kept.length; } } finally { await reader.cancel(); } }
      const original = Buffer.concat(chunks).toString('utf8');
      let parsed: unknown; try { parsed = JSON.parse(original); } catch { parsed = original; }
      const redact = (value: unknown, depth = 0): unknown => {
        if (depth > 12) return '[truncated]';
        if (typeof value === 'string') return value.split(this.options.apiKey || '\0').join('[redacted]').replace(/Bearer\s+[^\s"<>]+/gi, 'Bearer [redacted]').replace(/\bsk-[\w-]+/g, '[redacted]');
        if (Array.isArray(value)) return value.slice(0, 100).map(v => redact(v, depth + 1));
        if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).slice(0, 100).map(([key, v]) => [key, /authorization|api.?key|token|secret|password/i.test(key) ? '[redacted]' : redact(v, depth + 1)]));
        return value;
      };
      const id = randomUUID(); await mkdir(this.options.diagnosticRoot, { recursive: true });
      await writeFile(join(this.options.diagnosticRoot, `${id}.json`), JSON.stringify({ id, createdAt: new Date().toISOString(), status: response.status, endpoint: path.split('?')[0], upstream: redact(parsed) }, null, 2), { flag: 'wx', mode: 0o600 });
      return id;
    } catch { return null; } // Diagnostics cannot turn a known failed request into a replayable/uncertain success.
  }
  async capabilities(): Promise<Capabilities> {
    if (this.caps && Date.now() - this.caps.at < 300000) return this.caps.value;
    const data = await this.json('/videos/models'); const cap = data.data?.find((x: Capabilities) => x.id === this.videoModel);
    if (!cap) throw new AppError(400, '当前视频模型未在 OpenRouter 视频目录中找到');
    this.caps = { value: cap, at: Date.now() }; return cap;
  }
  async validate(board: Storyboard) {
    this.key(); const cap = await this.capabilities();
    if (!cap.supported_resolutions?.includes(this.resolution)) throw new AppError(400, '模型不支持当前分辨率');
    if (!cap.supported_aspect_ratios?.includes('16:9')) throw new AppError(400, '模型不支持16:9画幅');
    if (board.shots.some(s => !cap.supported_durations?.includes(s.duration))) throw new AppError(400, `镜头时长不受支持，请使用 ${cap.supported_durations.join('/')} 秒`);
  }
  async estimate(board: Storyboard) {
    const cap = await this.capabilities(); const sku = cap.pricing_skus ?? {};
    const dollars = sku[`duration_seconds_${this.resolution}`] ?? sku.duration_seconds;
    const cents = sku[`cents_per_second_output_${this.resolution.toLowerCase()}`] ?? sku.cents_per_second_output;
    const rate = dollars != null ? Number(dollars) : cents != null ? Number(cents) / 100 : null;
    const endpoint = await this.json(`/images/models/${this.imageModel}/endpoints`);
    const prices = (endpoint.endpoints ?? []).flatMap((e: any) => e.pricing ?? []).filter((p: any) => p.billable === 'output_image' && p.unit === 'image' && (!p.variant || p.variant === (this.options.imageResolution || DEFAULT_IMAGE_RESOLUTION).toLowerCase())).map((p: any) => Number(p.cost_usd));
    const imageRate = prices.length ? Math.min(...prices) : null;
    const seconds = board.shots.reduce((sum, s) => sum + s.duration, 0);
    return { videoModel: this.videoModel, imageModel: this.imageModel, resolution: this.resolution, shots: board.shots.length, seconds,
      videoUsd: rate === null ? null : seconds * rate, imageUsd: imageRate === null ? null : board.shots.length * imageRate,
      ratePerSecond: rate, checkedAt: new Date().toISOString(), note: '目录估算，不含分镜模型、重试及额外输入费用，以实际账单为准' };
  }
  async image(shot: Storyboard['shots'][number], output: string) {
    return this.generateImage(shot.imagePrompt, output, '16:9');
  }
  async portrait(prompt: string, output: string) { return this.generateImage(prompt, output, '1:1'); }
  portraitConfig() { return { model: this.imageModel, parameters: { resolution: this.options.imageResolution || DEFAULT_IMAGE_RESOLUTION, aspect_ratio: '1:1', n: 1 } }; }
  generationConfig(kind: 'image' | 'video' | 'compose') { return kind === 'image' ? { model: this.imageModel, parameters: { resolution: this.options.imageResolution || DEFAULT_IMAGE_RESOLUTION, aspect_ratio: '16:9', n: 1 } } : kind === 'video' ? { model: this.videoModel, parameters: { resolution: this.resolution, aspect_ratio: '16:9', generate_audio: false } } : { model: 'ffmpeg', parameters: { width: 1280, height: 720, fps: 24 } }; }
  async estimatePortrait() {
    const endpoint = await this.json(`/images/models/${this.imageModel}/endpoints`);
    const prices = (endpoint.endpoints ?? []).flatMap((e: any) => e.pricing ?? []).filter((p: any) => p.billable === 'output_image' && p.unit === 'image' && (!p.variant || p.variant === (this.options.imageResolution || DEFAULT_IMAGE_RESOLUTION).toLowerCase())).map((p: any) => Number(p.cost_usd)).filter(Number.isFinite);
    return { imageModel: this.imageModel, imageUsd: prices.length ? Math.min(...prices) : null, checkedAt: new Date().toISOString(), note: '单张候选图目录估算，不含额外输入及重试费用，以供应商账单为准' };
  }
  private async generateImage(prompt: string, output: string, aspectRatio: string) {
    const result = await this.json('/images', { model: this.imageModel, prompt, resolution: this.options.imageResolution || DEFAULT_IMAGE_RESOLUTION, aspect_ratio: aspectRatio, n: 1 });
    // A 2xx image response may already be billed. Local decoding/storage errors
    // must never turn it back into a safe-to-repeat POST.
    try {
      const data = result.data?.[0];
      if (!data?.b64_json || !['image/png', 'image/jpeg', 'image/webp'].includes(data.media_type)) throw new Error('Unsupported image response');
      if (data.b64_json.length > 40_000_000) throw new Error('Image too large');
      await mkdir(dirname(output), { recursive: true }); await writeFile(output, Buffer.from(data.b64_json, 'base64'));
    } catch { throw new UncertainSubmission(); }
  }
  async video(shot: Storyboard['shots'][number], output: string, task?: TaskContext) {
    this.key(); let id = task?.providerTaskId;
    if (!id) {
      const result = await this.json('/videos', { model: this.videoModel, prompt: shot.videoPrompt, duration: shot.duration, resolution: this.resolution, aspect_ratio: '16:9', generate_audio: false });
      if (typeof result?.id !== 'string' || !result.id) throw new UncertainSubmission();
      const submittedId: string = result.id; id = submittedId;
      try { task?.persistTaskId(submittedId); }
      catch { throw new UncertainSubmission(); }
    }
    if (!id) throw new UncertainSubmission();
    for (let i = 0; i < (this.options.maxPolls ?? 180); i++) {
      const status = await this.json(`/videos/${encodeURIComponent(id)}`);
      if (status.status === 'completed') { await this.download(`/videos/${encodeURIComponent(id)}/content?index=0`, output); return; }
      if (['failed', 'cancelled', 'canceled'].includes(status.status)) throw new ProviderFailed();
      await sleep(this.options.pollMs ?? 5000);
    }
    throw new AppError(504, '云端视频仍未完成；任务ID已保存，重试将查询已有任务，不重复提交');
  }
  private async download(path: string, output: string) {
    let url = new URL(this.base + path); let response: Response | undefined;
    for (let n = 0; n < 4; n++) {
      const same = url.origin === new URL(this.base).origin;
      if (!same && (url.protocol !== 'https:' || !['.fal.media', '.fal.ai', '.cloudfront.net', '.amazonaws.com', '.blob.core.windows.net', '.googleusercontent.com', '.r2.cloudflarestorage.com'].some(s => url.hostname.endsWith(s)))) throw new AppError(502, '下载重定向到未批准的媒体存储域名');
      response = await this.fetcher(url.toString(), { headers: same ? this.headers() : {}, redirect: 'manual', signal: AbortSignal.timeout(120000) });
      if (response.status >= 300 && response.status < 400) { const location = response.headers.get('location'); if (!location) break; url = new URL(location, url); continue; }
      break;
    }
    if (!response?.ok || !response.body) throw new AppError(502, '云端视频下载失败，已保留任务ID');
    const chunks: Uint8Array[] = []; let size = 0;
    for await (const chunk of response.body as any as AsyncIterable<Uint8Array>) { size += chunk.length; if (size > 256 * 1024 * 1024) throw new AppError(502, '单片段超过256MB限制'); chunks.push(chunk); }
    if (!size) throw new AppError(502, '下载的视频为空');
    await mkdir(dirname(output), { recursive: true }); await writeFile(output, Buffer.concat(chunks));
  }
}
