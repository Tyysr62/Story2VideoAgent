import { createHash } from 'node:crypto';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { z } from 'zod';
import { AppError, type Storyboard } from '../domain/storyboard.js';
import { validateCharacterRef } from '../domain/characters.js';
import { validatePortrait } from '../characters/images.js';
import type { Repository } from '../storage/repository.js';
import type { Composer, MediaBackend } from '../media/ffmpeg.js';
import { UncertainSubmission } from '../media/openrouter.js';
import { ProductionService, publicEntry } from './service.js';
import type { ProductionEntry } from './store.js';

export interface ReferenceImage { assetId: string; path: string; mime: string; sha256: string; }
export interface KeyframeInput { prompt: string; references: ReferenceImage[]; }
export interface M2Backend extends MediaBackend {
  generationConfig?(kind: 'image' | 'video' | 'compose'): { model: string; parameters: Record<string, unknown> };
  validateKeyframe?(references: number): Promise<unknown>;
  keyframe?(input: KeyframeInput, output: string): Promise<void>;
  estimatePortrait?(): Promise<{ imageUsd: number | null }>;
}
export const batchSchema = z.object({ revision: z.number().int().nonnegative(), requestId: z.string().regex(/^[\w-]{1,100}$/), shotIds: z.array(z.string().min(1).max(80)).min(1).max(20).refine(v => new Set(v).size === v.length), acceptCost: z.boolean(), force: z.boolean().optional() }).strict();
type Batch = z.input<typeof batchSchema>;
export const fingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export class M2Service {
  private active = new Set<Promise<unknown>>();
  readonly files: ProductionService;
  constructor(readonly repo: Repository, readonly root: string, readonly media: M2Backend, readonly composer: Composer) { this.files = new ProductionService(repo, root); }
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
    const prompt = `生成单张16:9分镜首帧，不要拼图、文字或水印。保持参考人物的身份、年龄造型和服装；将人物放入具体场景构图。\n画风：${p.storyboard!.style}\n镜头：${shot.description}\n摄影：${shot.camera}\n图像要求：${shot.imagePrompt}\n${roles.map(r => `参考图 ${r.reference} 对应 ${r.name}；身份：${r.identity}；造型：${r.look}`).join('\n')}`;
    const config = this.config('image'); const stableRoles = roles.map(({ name: _name, ...r }) => r);
    const hash = fingerprint({ style: p.storyboard!.style, description: shot.description, camera: shot.camera, prompt: shot.imagePrompt, roles: stableRoles, references: references.map(({ path: _path, ...r }) => r), config });
    return { prompt, references, hash, config, shot, roles };
  }
  view(id: string) {
    const p = this.project(id); const state = this.repo.m2.get(id);
    const shots = p.storyboard!.shots.map(shot => {
      let inputHash = ''; let blocked: string | undefined;
      try { inputHash = this.compile(id, shot.id).hash; } catch (error) { blocked = error instanceof AppError ? error.message : '首帧输入不可用'; }
      const selected = state.keyframes[shot.id]; const entry = selected ? this.repo.production.get(id, selected) : undefined;
      const current = Boolean(!blocked && entry?.status === 'succeeded' && entry.inputHash === inputHash && entry.file);
      const candidates = this.repo.production.list(id).filter(e => e.kind === 'keyframe' && e.shotId === shot.id && e.status === 'succeeded').map(e => ({ id: e.id, label: e.label, current: e.inputHash === inputHash }));
      return { shotId: shot.id, title: shot.title, inputHash, current, blocked, entry: entry ? publicEntry(entry) : undefined, candidates };
    });
    const manifestHash = fingerprint({ shots: shots.map(s => ({ id: s.shotId, inputHash: s.inputHash, selected: s.entry?.id, sha256: s.entry?.file?.sha256 })), board: p.storyboard, characters: this.repo.characters.snapshot(id).approval?.manifestHash, videoConfig: this.config('video') });
    const complete = shots.every(s => s.current) && Boolean(this.repo.characters.snapshot(id).approval);
    return { revision: p.revision, shots, manifestHash, approved: complete && state.approval?.hash === manifestHash, complete, imageModel: this.config('image').model, videoModel: this.config('video').model };
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
  async recover() {
    for (const p of this.repo.listProjects().filter(p => p.workflowVersion === 2)) {
      for (const e of this.repo.production.list(p.id).filter(e => e.kind === 'keyframe' && e.status === 'running')) this.repo.production.update(p.id, e.id, { status: this.media.simulated ? 'failed' : 'unknown', error: '首帧生成被中断，请核实云端任务，禁止自动重提' });
      if (p.status === 'generating') this.repo.updateProject(p.id, { status: 'failed', error: '首帧生产被中断，请检查生产库中的任务状态' });
    }
  }
}
