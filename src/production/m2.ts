import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { z } from 'zod';
import { AppError, type Storyboard } from '../domain/storyboard.js';
import { validateCharacterRef } from '../domain/characters.js';
import { validatePortrait } from '../characters/images.js';
import type { Repository } from '../storage/repository.js';
import { inspectMedia, MissingAudioTrack, COMPOSE_PARAMETERS, type Composer, type MediaBackend } from '../media/ffmpeg.js';
import { ProviderFailed, UncertainSubmission } from '../media/openrouter.js';
import { ProductionService, publicEntry } from './service.js';
import type { ProductionEntry } from './store.js';
import { compileVideoPrompt, VIDEO_PROMPT_VERSION } from '../media/video-prompt.js';

export interface ReferenceImage { assetId: string; path: string; mime: string; sha256: string; }
export interface KeyframeInput { prompt: string; references: ReferenceImage[]; }
export interface M2Backend extends MediaBackend {
  generationConfig?(kind: 'image' | 'video' | 'compose'): { model: string; parameters: Record<string, unknown> };
  validateKeyframe?(references: number): Promise<unknown>;
  keyframe?(input: KeyframeInput, output: string): Promise<void>;
  estimatePortrait?(): Promise<{ imageUsd: number | null }>;
  validateImageToVideo?(board: Storyboard): Promise<void>;
  estimateImageToVideo?(board: Storyboard): Promise<{ videoUsd: number | null; note?: string }>;
}
export interface FrameTransport { readonly configured: boolean; frame(entry: ProductionEntry, path: string): Promise<string>; }
export const batchSchema = z.object({ revision: z.number().int().nonnegative(), requestId: z.string().regex(/^[\w-]{1,100}$/), shotIds: z.array(z.string().min(1).max(80)).min(1).max(20).refine(v => new Set(v).size === v.length), acceptCost: z.boolean(), force: z.boolean().optional() }).strict();
type Batch = z.input<typeof batchSchema>;
export const fingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export class M2Service {
  private active = new Set<Promise<unknown>>();
  readonly files: ProductionService;
  constructor(readonly repo: Repository, readonly root: string, readonly media: M2Backend, readonly composer: Composer, private transport?: FrameTransport) { this.files = new ProductionService(repo, root); }
  private project(id: string) { const p = this.repo.getProject(id); if (p.workflowVersion !== 2 || !p.storyboard) throw new AppError(409, '请先启用角色参考并保存分镜'); return p; }
  private idleProject(id: string) { const p = this.project(id); if (['generating', 'planning'].includes(p.status) || this.repo.portraits.list(id).some(j => j.status === 'running')) throw new AppError(409, '项目正在生产，请等待完成'); return p; }
  config(kind: 'image' | 'video' | 'compose') { return this.media.generationConfig?.(kind) ?? { model: this.media.simulated ? `offline-${kind}` : 'unconfigured', parameters: {} }; }
  compile(id: string, shotId: string) {
    const p = this.project(id); const shot = p.storyboard!.shots.find(s => s.id === shotId); if (!shot) throw new AppError(404, '镜头不属于当前分镜');
    const library = this.repo.characters.snapshot(id); const refs = shot.characterRefs ?? []; const references: ReferenceImage[] = [];
    const roles = refs.map((ref, i) => {
      const version = validateCharacterRef(library, ref); if (!version.imageAssetId) throw new AppError(409, '出镜角色尚无参考图');
      const c = library.characters.find(c => c.id === ref.characterId)!; const l = c.looks.find(l => l.id === ref.lookId)!; const asset = this.repo.characters.getImageAsset(id, version.imageAssetId);
      references.push({ assetId: asset.id, path: join(this.root, asset.path), mime: asset.mime, sha256: asset.sha256 });
      return { reference: i + 1, ...ref, identity: c.description, look: version.description, name: `${c.name} · ${l.name}` };
    });
    const prompt = `生成单张16:9分镜首帧，不要拼图、文字或水印。保持参考人物的身份、年龄造型和服装；将人物放入具体场景构图。\n画风：${p.storyboard!.style}\n镜头：${shot.description}\n摄影：${shot.camera}\n图像要求：${shot.imagePrompt}\n${roles.map(r => `参考图 ${r.reference} 中的人物；身份：${r.identity}；造型：${r.look}`).join('\n')}`;
    const config = this.config('image'); const stableRoles = roles.map(({ name: _name, ...r }) => r);
    const hash = fingerprint({ style: p.storyboard!.style, description: shot.description, camera: shot.camera, prompt: shot.imagePrompt, roles: stableRoles, references: references.map(({ path: _path, ...r }) => r), config });
    return { prompt, references, hash, config, shot, roles };
  }
  view(id: string) {
    const p = this.project(id); const state = this.repo.m2.get(id); const entries = this.repo.production.list(id);
    const shots = p.storyboard!.shots.map(shot => {
      let inputHash = ''; let blocked: string | undefined;
      try { inputHash = this.compile(id, shot.id).hash; } catch (error) { blocked = error instanceof AppError ? error.message : '首帧输入不可用'; }
      const selected = state.keyframes[shot.id]; const entry = selected ? this.repo.production.get(id, selected) : undefined;
      const current = Boolean(!blocked && entry?.status === 'succeeded' && entry.inputHash === inputHash && entry.file);
      const candidates = entries.filter(e => e.kind === 'keyframe' && e.shotId === shot.id && e.status === 'succeeded').map(e => ({ id: e.id, label: e.label, current: e.inputHash === inputHash }));
      const video = state.videos[shot.id] ? this.repo.production.get(id, state.videos[shot.id]) : undefined;
      const videoCurrent = Boolean(current && entry && video?.status === 'succeeded' && video.file && video.inputHash === this.videoInput(id, shot.id, entry).hash);
      const latest = [...entries].reverse().find(e => e.kind === 'keyframe' && e.shotId === shot.id);
      const latestVideo = [...entries].reverse().find(e => e.kind === 'video' && e.shotId === shot.id);
      const videoResumable = Boolean(current && entry && entries.some(e => e.kind === 'video' && e.inputHash === this.videoInput(id, shot.id, entry).hash && e.providerTaskId && !e.providerTerminal && e.status !== 'succeeded'));
      return { shotId: shot.id, title: shot.title, inputHash, current, blocked, entry: entry ? publicEntry(entry) : undefined, candidates, videoCurrent, videoResumable, video: video ? publicEntry(video) : undefined, error: latest && ['failed', 'unknown'].includes(latest.status) ? latest.error : undefined, videoError: latestVideo && ['failed', 'unknown'].includes(latestVideo.status) ? latestVideo.error : undefined };
    });
    const manifestHash = fingerprint({ shots: shots.map(s => ({ id: s.shotId, inputHash: s.inputHash, selected: s.entry?.id, sha256: s.entry?.file?.sha256 })), board: p.storyboard, characters: this.repo.characters.snapshot(id).approval?.manifestHash, videoConfig: this.config('video') });
    const complete = shots.every(s => s.current) && Boolean(this.repo.characters.snapshot(id).approval);
    return { revision: p.revision, shots, manifestHash, approved: complete && state.approval?.hash === manifestHash, complete, imageModel: this.config('image').model, videoModel: this.config('video').model, transportConfigured: this.media.simulated || Boolean(this.transport?.configured) };
  }
  private ready(id: string, revision: number) { const p = this.idleProject(id); this.repo.assertRevision(p, revision); if (!this.repo.characters.snapshot(id).approval) throw new AppError(409, '请先确认角色定稿'); this.repo.characters.validateStoryboard(id, p.storyboard!, true); return p; }
  async frames(id: string, raw: Batch) {
    const input = batchSchema.parse(raw); const requestHash = fingerprint({ action: 'frames', ...input });
    if (this.repo.m2.request(id, input.requestId, requestHash)) return this.view(id);
    if (!input.acceptCost) throw new AppError(409, '请先确认本次首帧生成费用');
    const p = this.ready(id, input.revision); const compiled = input.shotIds.map(shotId => this.compile(id, shotId));
    for (const c of compiled) if (this.repo.production.list(id).some(e => e.kind === 'keyframe' && e.inputHash === c.hash && e.status === 'unknown')) throw new UncertainSubmission();
    if (!this.media.keyframe) throw new AppError(503, '当前媒体后端尚未配置首帧生成');
    this.repo.updateProject(id, { status: 'generating', error: null });
    const work = (async () => {
      try {
        for (const c of compiled) { await this.media.validateKeyframe?.(c.references.length); for (const r of c.references) await this.files.file(id, `character:${r.assetId}`); }
        this.repo.m2.begin(id, input.requestId, requestHash);
        for (const c of compiled) {
          const state = this.repo.m2.get(id); const old = state.keyframes[c.shot.id] ? this.repo.production.get(id, state.keyframes[c.shot.id]) : undefined;
          if (!input.force && old?.inputHash === c.hash && old.status === 'succeeded') { await this.files.file(id, old.id); continue; }
          const entry = this.repo.production.create({ projectId: id, kind: 'keyframe', label: `${c.shot.title} · 分镜首帧`, revision: p.revision, shotId: c.shot.id, status: 'running', prompt: c.prompt, model: c.config.model, parameters: c.config.parameters, dependencies: c.references.map(r => `character:${r.assetId}`), inputHash: c.hash, content: { roles: c.roles, references: c.references.map(({ path: _path, ...r }) => r), shot: c.shot }, simulated: this.media.simulated });
          this.repo.event(id, 'keyframe.started', { entryId: entry.id, shotId: c.shot.id });
          const output = join(this.root, 'production', id, `${entry.id}.image`); await mkdir(dirname(output), { recursive: true });
          this.repo.production.recordOutput(id, entry.id, relative(this.root, output));
          try {
            await this.media.keyframe!({ prompt: c.prompt, references: c.references }, output);
            const bytes = await readFile(output); const mime = bytes[0] === 255 ? 'image/jpeg' : bytes.toString('ascii', 0, 4) === 'RIFF' ? 'image/webp' : 'image/png'; await validatePortrait(bytes, mime);
            this.repo.production.update(id, entry.id, { status: 'succeeded', file: { path: relative(this.root, output), mime, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') } });
            state.keyframes[c.shot.id] = entry.id; delete state.approval; delete state.finalId; this.repo.m2.save(id, state); this.repo.updateProject(id, { finalArtifactId: null });
            this.repo.event(id, 'keyframe.succeeded', { entryId: entry.id, shotId: c.shot.id });
          } catch (error) {
            const partial = await readFile(output).catch(() => null); const unknown = error instanceof UncertainSubmission || (!this.media.simulated && Boolean(partial));
            const message = error instanceof AppError ? error.message : '首帧生成或保存失败';
            this.repo.production.update(id, entry.id, { status: unknown ? 'unknown' : 'failed', error: message, ...(partial?.length ? { file: { path: relative(this.root, output), mime: 'application/octet-stream', bytes: partial.length, sha256: createHash('sha256').update(partial).digest('hex') } } : {}) });
            this.repo.event(id, 'keyframe.failed', { entryId: entry.id, shotId: c.shot.id, unknown }); break;
          }
        }
      } finally { this.repo.updateProject(id, { status: 'awaiting_approval' }); }
    })();
    this.active.add(work); try { await work; } finally { this.active.delete(work); } return this.view(id);
  }
  async select(id: string, revision: number, shotId: string, entryId: string) {
    this.ready(id, revision); const entry = this.repo.production.get(id, entryId); await this.files.file(id, entryId); this.ready(id, revision);
    if (entry.kind !== 'keyframe' || entry.shotId !== shotId || entry.status !== 'succeeded' || entry.inputHash !== this.compile(id, shotId).hash) throw new AppError(409, '首帧版本与当前镜头不匹配或已过期');
    const state = this.repo.m2.get(id); state.keyframes[shotId] = entryId; delete state.approval; delete state.finalId; this.repo.m2.save(id, state); this.repo.updateProject(id, { finalArtifactId: null, status: 'awaiting_approval' }); this.repo.event(id, 'keyframe.selected', { entryId, shotId }); return this.view(id);
  }
  async approve(id: string, revision: number, manifestHash: string) {
    this.ready(id, revision); const view = this.view(id); if (!view.complete || view.manifestHash !== manifestHash) throw new AppError(409, '首帧清单缺失或已过期，请重新检查全部首帧');
    for (const shot of view.shots) await this.files.file(id, shot.entry!.id);
    this.ready(id, revision); if (this.view(id).manifestHash !== manifestHash) throw new AppError(409, '首帧确认清单已变化');
    const state = this.repo.m2.get(id); state.approval = { hash: manifestHash, at: new Date().toISOString() }; this.repo.m2.save(id, state); this.repo.event(id, 'keyframes.approved', { manifestHash }); return this.view(id);
  }
  async estimateFrames(id: string, shotIds: string[]) { this.project(id); const compiled = shotIds.map(s => this.compile(id, s)); for (const c of compiled) await this.media.validateKeyframe?.(c.references.length); const quote = this.media.estimatePortrait ? await this.media.estimatePortrait() : { imageUsd: this.media.simulated ? 0 : null }; return { imageUsd: quote.imageUsd == null ? null : quote.imageUsd * compiled.length, shots: compiled.length, simulated: this.media.simulated, note: '首帧输出目录估算，不含参考图输入与重试费用，以实际账单为准' }; }
  async idle() { await Promise.allSettled([...this.active]); }
  private videoInput(id: string, shotId: string, frame: ProductionEntry) {
    const p = this.project(id); const shot = p.storyboard!.shots.find(s => s.id === shotId); if (!shot || !frame.file) throw new AppError(409, '视频缺少镜头首帧');
    const config = this.config('video'); const board = { ...p.storyboard!, characters: this.repo.characters.snapshot(id).characters };
    const prompt = compileVideoPrompt(board, shot, 'first_frame');
    return { prompt, config, shot, hash: fingerprint({ prompt, duration: shot.duration, frameId: frame.id, frameSha: frame.file.sha256, config }) };
  }
  private async outputFile(path: string, mime: string) { const info = await stat(path); if (!info.size) throw new AppError(502, '生成文件为空'); const hash = createHash('sha256'); for await (const chunk of createReadStream(path)) hash.update(chunk); return { path: relative(this.root, path), mime, bytes: info.size, sha256: hash.digest('hex') }; }
  async estimateVideos(id: string, shotIds: string[]) { const p = this.project(id); const shots = shotIds.map(id => { const s = p.storyboard!.shots.find(s => s.id === id); if (!s) throw new AppError(404, '镜头不属于项目'); return s; }); const quote = this.media.estimateImageToVideo ? await this.media.estimateImageToVideo({ ...p.storyboard!, shots }) : { videoUsd: this.media.simulated ? 0 : null }; return { ...quote, shots: shots.length, simulated: this.media.simulated, note: '首帧参考视频目录估算，不适用纯文生视频单价；不含对象存储、重试和分镜费用，以实际账单为准' }; }
  async videos(id: string, raw: Batch & { manifestHash: string }) {
    const { manifestHash, ...batch } = raw; const input = batchSchema.parse(batch); const requestHash = fingerprint({ action: 'videos', ...input, manifestHash });
    if (this.repo.m2.request(id, input.requestId, requestHash)) return this.view(id);
    if (!input.acceptCost) throw new AppError(409, '请先确认本次视频生成费用');
    const p = this.ready(id, input.revision); const view = this.view(id); if (!view.approved || view.manifestHash !== manifestHash) throw new AppError(409, '请先确认当前整组首帧清单');
    const compiled = input.shotIds.map(shotId => { const row = view.shots.find(s => s.shotId === shotId); if (!row?.entry || !row.current) throw new AppError(409, '镜头首帧不可用'); const frame = this.repo.production.get(id, row.entry.id); return { ...this.videoInput(id, shotId, frame), frame }; });
    for (const c of compiled) if (this.repo.production.list(id).some(e => e.kind === 'video' && e.shotId === c.shot.id && e.inputHash !== c.hash && e.providerTaskId && !e.providerTerminal && e.status !== 'succeeded')) throw new AppError(409, '该镜头存在旧版本云任务，请先到供应商核实原任务；已阻止另一次收费提交');
    for (const c of compiled) if (this.repo.production.list(id).some(e => e.kind === 'video' && e.inputHash === c.hash && e.status === 'unknown')) throw new UncertainSubmission();
    const newInputs = compiled.filter(c => { const row = view.shots.find(s => s.shotId === c.shot.id)!; return !(row.videoCurrent && !input.force) && !row.videoResumable; });
    if (newInputs.length && !this.media.simulated && !this.transport?.configured) throw new AppError(503, '请先在本地配置 S3 兼容对象存储，用于传输已确认首帧；未提交视频费用');
    if (newInputs.length && !this.media.simulated && !this.media.validateImageToVideo) throw new AppError(503, '视频后端未提供首帧能力校验');
    this.repo.updateProject(id, { status: 'generating', error: null });
    const work = (async () => {
      try {
        if (newInputs.length) await this.media.validateImageToVideo?.({ ...p.storyboard!, shots: newInputs.map(c => c.shot) });
        for (const c of compiled) await this.files.file(id, c.frame.id);
        if (this.view(id).manifestHash !== manifestHash) throw new AppError(409, '生产输入已变化');
        this.repo.m2.begin(id, input.requestId, requestHash); let failed = false;
        for (const c of compiled) {
          const state = this.repo.m2.get(id); const existing = this.repo.production.list(id).filter(e => e.kind === 'video' && e.inputHash === c.hash);
          const selected = state.videos[c.shot.id] ? this.repo.production.get(id, state.videos[c.shot.id]) : undefined;
          if (!input.force && selected?.inputHash === c.hash && selected.status === 'succeeded') { await this.files.file(id, selected.id); continue; }
          const resuming = [...existing].reverse().find(e => e.providerTaskId && !e.providerTerminal && e.status !== 'succeeded');
          const entry = resuming ?? this.repo.production.create({ projectId: id, kind: 'video', label: `${c.shot.title} · 首帧视频`, revision: p.revision, shotId: c.shot.id, status: 'running', prompt: c.prompt, model: c.config.model, parameters: { ...c.config.parameters, duration: c.shot.duration, frame_type: 'first_frame', promptVersion: VIDEO_PROMPT_VERSION, audioMode: c.shot.audio?.mode ?? 'silent' }, dependencies: [c.frame.id], inputHash: c.hash, content: { shot: c.shot, audioProfile: p.storyboard!.audioProfile, firstFrameSha: c.frame.file!.sha256, approvalHash: manifestHash }, simulated: this.media.simulated });
          this.repo.production.update(id, entry.id, { status: 'running', error: undefined }); this.repo.event(id, 'video.started', { entryId: entry.id, shotId: c.shot.id, resuming: Boolean(resuming) });
          const output = join(this.root, 'production', id, `${entry.id}-${Date.now()}.mp4`); await mkdir(dirname(output), { recursive: true });
          this.repo.production.recordOutput(id, entry.id, relative(this.root, output));
          try {
            const firstFrameUrl = !entry.providerTaskId ? this.transport ? await this.transport.frame(c.frame, (await this.files.file(id, c.frame.id)).path) : this.media.simulated ? 'https://offline.invalid/fixture.png' : undefined : undefined;
            await this.media.video({ ...c.shot, videoPrompt: c.prompt }, output, { providerTaskId: entry.providerTaskId, firstFrameUrl, persistTaskId: providerTaskId => { this.repo.production.update(id, entry.id, { providerTaskId }); } });
            const info = await inspectMedia(output); if (c.shot.audio && c.shot.audio.mode !== 'silent' && !info.hasAudio) throw new MissingAudioTrack();
            this.repo.production.update(id, entry.id, { status: 'succeeded', file: await this.outputFile(output, 'video/mp4') }); state.videos[c.shot.id] = entry.id; delete state.finalId; this.repo.m2.save(id, state); this.repo.updateProject(id, { finalArtifactId: null }); this.repo.event(id, 'video.succeeded', { entryId: entry.id, shotId: c.shot.id });
          } catch (error) {
            const saved = this.repo.production.get(id, entry.id); const unknown = error instanceof UncertainSubmission && !saved.providerTaskId;
            this.repo.production.update(id, entry.id, { status: unknown ? 'unknown' : 'failed', providerTerminal: error instanceof ProviderFailed || error instanceof MissingAudioTrack, error: error instanceof AppError ? error.message : '视频生成或保存失败；若已有云任务 ID，可继续查询原任务' });
            const partial = await this.outputFile(output, error instanceof MissingAudioTrack ? 'video/mp4' : 'application/octet-stream').catch(() => null); if (partial) this.repo.production.create({ projectId: id, kind: 'video', label: `${c.shot.title} · ${error instanceof MissingAudioTrack ? '缺少音轨的原片' : '未校验输出'}`, status: 'failed', file: partial, dependencies: [entry.id], simulated: this.media.simulated });
            this.repo.event(id, 'video.failed', { entryId: entry.id, shotId: c.shot.id, unknown }); failed = true; break;
          }
        }
        if (!failed && this.view(id).shots.every(s => s.videoCurrent)) {
          const state = this.repo.m2.get(id); const clips = p.storyboard!.shots.map(s => this.repo.production.get(id, state.videos[s.id])); const inputs: string[] = [];
          for (const clip of clips) inputs.push((await this.files.file(id, clip.id)).path);
          const options = { mute: p.storyboard!.shots.map(s => !s.audio || s.audio.mode === 'silent') };
          const hash = fingerprint({ clips: clips.map(c => [c.id, c.file!.sha256]), config: this.config('compose'), composer: COMPOSE_PARAMETERS, options });
          let final = this.repo.production.list(id).find(e => e.kind === 'compose' && e.inputHash === hash && e.status === 'succeeded');
          if (final) await this.files.file(id, final.id);
          else {
            final = this.repo.production.create({ projectId: id, kind: 'compose', label: '首帧视频合成成片', status: 'running', inputHash: hash, dependencies: clips.map(c => c.id), model: 'ffmpeg', parameters: { ...COMPOSE_PARAMETERS, ...options }, revision: p.revision, simulated: this.media.simulated });
            const path = join(this.root, 'production', id, `${final.id}.mp4`);
            this.repo.production.recordOutput(id, final.id, relative(this.root, path));
            try { await this.composer.compose(inputs, path, options); final = this.repo.production.update(id, final.id, { status: 'succeeded', file: await this.outputFile(path, 'video/mp4') }); }
            catch { this.repo.production.update(id, final.id, { status: 'failed', error: '本地视频拼接失败，已保留全部镜头素材' }); await this.files.recoverOutputs(id); throw new AppError(502, '本地视频拼接失败'); }
          }
          if (this.view(id).manifestHash !== manifestHash || !this.view(id).approved) throw new AppError(409, '首帧清单已变化，停止发布成片');
          this.repo.saveArtifact({ id: final.id, projectId: id, revision: p.revision, shotId: null, kind: 'compose', ...final.file!, simulated: this.media.simulated, createdAt: final.createdAt }); state.finalId = final.id; this.repo.m2.save(id, state); this.repo.updateProject(id, { status: 'ready', finalArtifactId: final.id }); this.repo.event(id, 'project.ready', { revision: p.revision, artifactId: final.id });
        }
      } finally { if (this.repo.getProject(id).status === 'generating') this.repo.updateProject(id, { status: 'awaiting_approval' }); }
    })();
    this.active.add(work); try { await work; } finally { this.active.delete(work); } return this.view(id);
  }
  async recover() {
    for (const p of this.repo.listProjects().filter(p => p.workflowVersion === 2)) {
      await this.files.recoverOutputs(p.id);
      for (const e of this.repo.production.list(p.id).filter(e => e.kind === 'keyframe' && e.status === 'running')) this.repo.production.update(p.id, e.id, { status: this.media.simulated ? 'failed' : 'unknown', error: '首帧生成被中断，请核实云端任务，禁止自动重提' });
      for (const e of this.repo.production.list(p.id).filter(e => ['video', 'compose'].includes(e.kind) && e.status === 'running')) this.repo.production.update(p.id, e.id, { status: e.providerTaskId || this.media.simulated || e.kind === 'compose' ? 'failed' : 'unknown', error: e.providerTaskId ? '已保留云任务 ID，可继续查询原任务' : '生产被中断，请核实任务状态' });
      if (p.status === 'generating') this.repo.updateProject(p.id, { status: 'failed', error: '首帧生产被中断，请检查生产库中的任务状态' });
    }
  }
}
