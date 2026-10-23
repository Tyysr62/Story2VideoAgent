import { randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative, resolve, isAbsolute } from 'node:path';
import { z } from 'zod';
import { AppError } from '../domain/storyboard.js';
import type { CharacterLibrary, GenerationSnapshot } from '../domain/characters.js';
import type { Repository } from '../storage/repository.js';
import { UncertainSubmission } from '../media/openrouter.js';
import { validatePortrait } from './images.js';

export interface PortraitBackend { readonly simulated: boolean; readonly imageModel?: string; portraitConfig?(): { model: string; parameters: Record<string, string | number | boolean> }; portrait(prompt: string, output: string): Promise<void>; estimatePortrait?(): Promise<unknown>; }
export const portraitRequestSchema = z.object({ revision: z.number().int().nonnegative(), characterId: z.string().min(1).max(100), lookId: z.string().min(1).max(100), requestId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/), acceptCost: z.boolean() }).strict();
export class CharacterService {
  readonly jobs;
  private active = new Set<Promise<unknown>>();
  constructor(readonly repo: Repository, readonly root: string, private backend: PortraitBackend) { this.jobs = repo.portraits; }
  assertIdle(projectId: string) {
    if (this.jobs.list(projectId).some(j => j.status === 'running')) throw new AppError(409, '角色图片正在生成，请等待完成');
    const p = this.repo.getProject(projectId);
    if (['planning', 'generating'].includes(p.status)) throw new AppError(409, '项目正在规划或生成，请等待完成');
  }
  private selected(projectId: string, revision: number, characterId: string, lookId: string) {
    const library = this.repo.characters.snapshot(projectId);
    if (library.revision !== revision) throw new AppError(409, '角色库版本已变化，请刷新后重试');
    const character = library.characters.find(c => c.id === characterId); const look = character?.looks.find(l => l.id === lookId);
    if (!character || !look) throw new AppError(404, '角色或造型不属于本项目');
    return { library, character, look, version: look.versions.find(v => v.id === look.selectedVersionId)! };
  }
  async upload(projectId: string, revision: number, characterId: string, lookId: string, bytes: Buffer, mime: string): Promise<CharacterLibrary> {
    this.assertIdle(projectId); this.selected(projectId, revision, characterId, lookId);
    const info = await validatePortrait(bytes, mime);
    // Recheck after asynchronous decoding; an overlapping edit must not attach to a stale version.
    this.assertIdle(projectId); this.selected(projectId, revision, characterId, lookId);
    const asset = await this.storeImage(projectId, bytes, info, 'upload');
    return this.repo.characters.updateLook(projectId, revision, characterId, lookId, { imageAssetId: asset.id });
  }
  private async storeImage(projectId: string, bytes: Buffer, info: Awaited<ReturnType<typeof validatePortrait>>, source: 'upload' | 'generated', generation?: GenerationSnapshot) {
    const id = randomUUID(); const ext = info.mime === 'image/jpeg' ? 'jpg' : info.mime.split('/')[1];
    const path = join('characters', projectId, `${id}.${ext}`); await mkdir(join(this.root, 'characters', projectId), { recursive: true });
    await writeFile(join(this.root, path), bytes, { flag: 'wx' });
    return this.repo.characters.saveImageAsset({ id, projectId, path, ...info, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), source, simulated: source === 'generated' && this.backend.simulated, ...(generation ? { generation } : {}) });
  }
  image(projectId: string, assetId: string) {
    const asset = this.repo.characters.getImageAsset(projectId, assetId); const path = resolve(this.root, asset.path); const rel = relative(resolve(this.root), path);
    if (isAbsolute(rel) || rel.startsWith('..')) throw new AppError(403, '参考图路径无效'); return { asset, path, relativePath: rel };
  }
  async estimate() { return this.backend.estimatePortrait ? this.backend.estimatePortrait() : { simulated: this.backend.simulated, imageUsd: this.backend.simulated ? 0 : null, note: '生成一次角色候选图；实际费用以供应商账单为准' }; }
  async generate(projectId: string, value: z.input<typeof portraitRequestSchema>) {
    const input = portraitRequestSchema.parse(value);
    if (!input.acceptCost) throw new AppError(409, '请先确认本次角色图片生成费用');
    const existing = this.jobs.get(projectId, input.requestId);
    if (existing) {
      if (existing.characterId !== input.characterId || existing.lookId !== input.lookId || existing.libraryRevision !== input.revision) throw new AppError(409, '请求编号已用于其他输入');
      return existing;
    }
    this.assertIdle(projectId);
    if (this.jobs.list(projectId).some(j => j.lookId === input.lookId && j.status === 'unknown')) throw new UncertainSubmission();
    const { character, look, version } = this.selected(projectId, input.revision, input.characterId, input.lookId);
    const style = this.repo.getProject(projectId).storyboard?.style ?? '清晰角色设定图';
    const prompt = `角色主参考图，单一人物，正面或四分之三视角，面部清晰，主体完整，简单纯色背景，不含文字、水印或分格。\n全局画风：${style}\n角色身份：${character.description}\n造型：${version.description}`;
    const now = new Date().toISOString();
    const config = this.backend.portraitConfig?.() ?? { model: this.backend.imageModel ?? (this.backend.simulated ? 'offline-fixture' : 'injected-adapter'), parameters: {} };
    const inputSnapshot: GenerationSnapshot = { ...config, prompt, identityDescription: character.description, lookDescription: version.description, style };
    const job = this.jobs.create({ id: input.requestId, projectId, characterId: character.id, lookId: look.id, lookVersionId: version.id, libraryRevision: input.revision,
      inputHash: createHash('sha256').update(JSON.stringify({ ...inputSnapshot, lookVersionId: version.id })).digest('hex'), inputSnapshot, status: 'running', assetId: null, error: null, createdAt: now, updatedAt: now });
    this.repo.event(projectId, 'portrait.started', { jobId: job.id, lookId: look.id, simulated: this.backend.simulated });
    const archived = this.repo.production.create({ id: `portrait-request:${job.id}`, projectId, kind: 'prompt', label: `${character.name} · ${look.name} 生图请求`, status: 'running', prompt, model: config.model, parameters: config.parameters, content: inputSnapshot, characterId: character.id, lookId: look.id, inputHash: job.inputHash, simulated: this.backend.simulated });
    const task = (async () => {
      let produced = false;
      const directory = join(this.root, 'characters', projectId, 'pending'); const output = join(directory, `${job.id}.image`);
      try {
        await mkdir(directory, { recursive: true });
        await this.backend.portrait(prompt, output); produced = true;
        const bytes = await readFile(output); const mime = bytes[0] === 255 ? 'image/jpeg' : bytes.toString('ascii', 0, 4) === 'RIFF' ? 'image/webp' : 'image/png';
        const info = await validatePortrait(bytes, mime); const asset = await this.storeImage(projectId, bytes, info, 'generated', inputSnapshot);
        this.repo.characters.updateLook(projectId, input.revision, character.id, look.id, { imageAssetId: asset.id });
        this.repo.event(projectId, 'portrait.succeeded', { jobId: job.id, assetId: asset.id });
        this.repo.production.update(projectId, archived.id, { status: 'succeeded', outputId: `character:${asset.id}` });
        return this.jobs.update(projectId, job.id, { status: 'succeeded', assetId: asset.id, error: null });
      } catch (error) {
        const unknown = error instanceof UncertainSubmission || (!this.backend.simulated && produced);
        const message = unknown ? '云端提交状态未知或已生成但未完整保存，请核实费用后处理，禁止自动重提' : error instanceof AppError ? error.message : '角色图片生成失败，请检查模型配置';
        this.repo.event(projectId, 'portrait.failed', { jobId: job.id, unknown });
        const partial = await readFile(output).catch(() => null);
        this.repo.production.update(projectId, archived.id, { status: unknown ? 'unknown' : 'failed', error: message, ...(partial?.length ? { file: { path: relative(this.root, output), mime: 'application/octet-stream', bytes: partial.length, sha256: createHash('sha256').update(partial).digest('hex') } } : {}) });
        return this.jobs.update(projectId, job.id, { status: unknown ? 'unknown' : 'failed', assetId: null, error: message });
      }
    })();
    this.active.add(task); try { return await task; } finally { this.active.delete(task); }
  }
  async recover() {
    for (const p of this.repo.listProjects()) for (const job of this.jobs.list(p.id)) if (job.status === 'running') {
      this.jobs.update(p.id, job.id, { status: 'unknown', assetId: job.assetId, error: '角色生成被中断，未确认云端状态，禁止自动重提' });
      this.repo.production.ensure({ id: `portrait-request:${job.id}`, projectId: p.id, kind: 'prompt', label: '角色生图请求', status: 'running', prompt: job.inputSnapshot?.prompt, model: job.inputSnapshot?.model, parameters: job.inputSnapshot?.parameters, content: job.inputSnapshot });
      this.repo.production.update(p.id, `portrait-request:${job.id}`, { status: 'unknown', error: '角色生成被中断，禁止自动重提' });
    }
  }
  async idle() { await Promise.all([...this.active]); }
}
