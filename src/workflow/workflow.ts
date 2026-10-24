import { readFile, stat, mkdir } from 'node:fs/promises';
import { ZodError } from 'zod';
import { existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { AppError, type Project, type Job, type Storyboard, type Artifact } from '../domain/storyboard.js';
import { Repository } from '../storage/repository.js';
import type { Planner } from '../director/pi-director.js';
import { inspectMedia, MissingAudioTrack, type Composer, type MediaBackend } from '../media/ffmpeg.js';
import { UncertainSubmission, ProviderFailed } from '../media/openrouter.js';
import { ProductionService } from '../production/service.js';
import { compileVideoPrompt, VIDEO_PROMPT_VERSION } from '../media/video-prompt.js';
import { MediaQueue } from '../media/queue.js';

type Backend = MediaBackend & { validate?(board: Storyboard): Promise<void>; estimate?(board: Storyboard): Promise<unknown>; generationConfig?(kind: Job['kind']): { model: string; parameters: Record<string, unknown> }; };
export class Workflow {
  private active = new Map<string, Promise<void>>();
  constructor(readonly repo: Repository, private planner: Planner, readonly media: Backend, private composer: Composer, readonly root: string, private queue = new MediaQueue()) {}
  async plan(id: string, revision: number): Promise<Project> {
    const p = this.repo.getProject(id); this.repo.assertRevision(p, revision);
    if (['generating', 'planning'].includes(p.status)) throw new AppError(409, '项目正在处理，请等待当前任务完成');
    this.repo.updateProject(id, { status: 'planning', approvedRevision: null, error: null }); this.repo.event(id, 'planning.started', { revision });
    const planning = this.repo.production.create({ projectId: id, kind: 'prompt', label: 'AI 分镜规划输入', status: 'running', prompt: p.story, revision, content: { characterLibrary: p.workflowVersion === 2 ? this.repo.characters.snapshot(id) : undefined } });
    let traceId: string | undefined; let outputId: string | undefined; let model: string | undefined;
    try {
      const board = await this.planner.plan(p.story, undefined, p.workflowVersion === 2 ? this.repo.characters.snapshot(id) : undefined, trace => {
        model = trace.model;
        traceId = this.repo.production.create({ projectId: id, kind: 'prompt', label: '导演实际请求 Prompt', status: 'running', revision, model, prompt: trace.userPrompt, content: { systemPrompt: trace.systemPrompt }, dependencies: [planning.id] }).id;
      });
      // Preserve the model result before role adoption or database validation can reject it.
      outputId = this.repo.production.create({ projectId: id, kind: 'storyboard', label: '导演分镜输出', status: 'running', revision, model, content: board, dependencies: [traceId ?? planning.id] }).id;
      const saved = this.repo.saveStoryboard(id, revision, board, true);
      for (const entryId of [planning.id, traceId, outputId]) if (entryId) this.repo.production.update(id, entryId, { status: 'succeeded', outputId: `board:${id}:r${saved.revision}` });
      return saved;
    } catch (e) {
      const failure = e instanceof ZodError ? new AppError(502, e.issues.some(issue => issue.path.at(-1) === 'name')
        ? '模型分镜中的角色名称不符合引用规则，请使用不含空格、括号或分隔符的简短称呼后重新规划'
        : '模型分镜未通过数据校验，请检查本次导演分镜输出后重新规划') : e;
      const message = failure instanceof AppError ? failure.message : '分镜规划失败，请重试';
      const current = this.repo.getProject(id);
      if (current.revision === revision && current.status === 'planning') this.repo.updateProject(id, { status: 'failed', error: message });
      for (const entryId of [planning.id, traceId, outputId]) if (entryId) this.repo.production.update(id, entryId, { status: 'failed', error: message });
      this.repo.event(id, 'planning.failed', { revision, message }); throw failure instanceof AppError ? failure : new AppError(502, message);
    }
  }
  async estimate(id: string) {
    const p = this.repo.getProject(id); if (!p.storyboard) throw new AppError(409, '请先生成分镜');
    return this.media.estimate ? this.media.estimate(p.storyboard) : { simulated: true, shots: p.storyboard.shots.length, videoUsd: 0, imageUsd: 0, note: '仅测试模拟，不产生费用' };
  }
  async start(id: string, revision: number): Promise<Project> {
    let p = this.repo.getProject(id); this.repo.assertRevision(p, revision);
    if (p.workflowVersion === 2) throw new AppError(409, 'V2 首帧驱动视频将在 M2 开放；当前仅交付角色库与引用，不会提交视频费用');
    if (p.status === 'planning') throw new AppError(409, '正在重新规划，请等待并确认新分镜');
    if (!p.storyboard || p.approvedRevision !== revision) throw new AppError(409, '请先确认当前版本的分镜');
    if (p.status === 'ready' || this.active.has(id)) return p;
    if (this.repo.jobs(id).some(j => j.revision === revision && j.status === 'unknown')) throw new UncertainSubmission();
    await this.media.validate?.(p.storyboard);
    p = this.repo.getProject(id); this.repo.assertRevision(p, revision);
    if (p.status === 'planning') throw new AppError(409, '正在重新规划，请等待并确认新分镜');
    if (p.approvedRevision !== revision) throw new AppError(409, '分镜确认已失效');
    if (this.active.has(id)) return p;
    this.repo.updateProject(id, { status: 'generating', error: null }); this.repo.event(id, 'generation.started', { revision, simulated: this.media.simulated });
    const task = Promise.resolve().then(() => this.run(id, revision)).catch(e => {
      const message = e instanceof AppError ? e.message : '任务处理失败；可检查日志并重试已确认的失败任务';
      const current = this.repo.getProject(id);
      if (current.revision === revision && current.status === 'generating') this.repo.updateProject(id, { status: 'failed', error: message });
      this.repo.event(id, 'generation.failed', { revision, message });
    }).finally(() => { this.active.delete(id); });
    this.active.set(id, task); return this.repo.getProject(id);
  }
  async idle(id?: string) { if (id) await this.active.get(id); else await Promise.all([...this.active.values()]); }
  async recover() {
    for (const p of this.repo.listProjects()) {
      await new ProductionService(this.repo, this.root).recoverOutputs(p.id);
      if (p.status === 'planning') { this.repo.updateProject(p.id, { status: 'failed', error: '分镜规划被中断，请重新发起规划' }); for (const e of this.repo.production.list(p.id).filter(e => e.kind === 'prompt' && e.status === 'running')) this.repo.production.update(p.id, e.id, { status: 'failed', error: '分镜规划被中断' }); continue; }
      if (p.status !== 'generating') continue;
      for (const e of this.repo.production.list(p.id).filter(e => ['image', 'video', 'compose'].includes(e.kind) && e.status === 'running')) this.repo.production.update(p.id, e.id, { status: !this.media.simulated && e.kind !== 'compose' && !e.providerTaskId ? 'unknown' : 'failed', error: '该次执行被中断，任务恢复会保留原云任务 ID' });
      for (const j of this.repo.jobs(p.id).filter(j => j.revision === p.revision && j.status === 'running')) {
        const uncertain = !this.media.simulated && j.kind !== 'compose' && !j.providerTaskId;
        this.repo.updateJob(j.id, { status: uncertain ? 'unknown' : 'queued' });
      }
      try { await this.start(p.id, p.revision); }
      catch (e) { this.repo.updateProject(p.id, { status: 'failed', error: e instanceof AppError ? e.message : '任务恢复失败' }); }
    }
  }
  private async run(id: string, revision: number) {
    const p = this.repo.getProject(id); const videos: string[] = [];
    await this.queue.batch('image', p.storyboard!.shots, async shot => {
      const image = this.repo.ensureJob({ projectId: id, revision, kind: 'image', shotId: shot.id });
      await this.execute(image, path => this.media.image(shot, path));
    });
    await this.queue.batch('video', p.storyboard!.shots, async (shot, index) => {
      const video = this.repo.ensureJob({ projectId: id, revision, kind: 'video', shotId: shot.id });
      const compiled = { ...shot, videoPrompt: compileVideoPrompt(p.storyboard!, shot, 'text') };
      const path = await this.execute(video, (path, productionId) => this.media.video(compiled, path, { providerTaskId: video.providerTaskId, persistTaskId: providerTaskId => { this.repo.updateJob(video.id, { providerTaskId }); this.repo.production.update(id, productionId, { providerTaskId }); } }));
      videos[index] = path;
    });
    const compose = this.repo.ensureJob({ projectId: id, revision, kind: 'compose', shotId: null });
    await this.execute(compose, path => this.composer.compose(videos, path, { mute: p.storyboard!.shots.map(s => !s.audio || s.audio.mode === 'silent') }));
    const current = this.repo.getProject(id); this.repo.assertRevision(current, revision);
    if (current.status !== 'generating' || current.approvedRevision !== revision) throw new AppError(409, '执行版本或确认状态已变化，停止发布成片');
    this.repo.updateProject(id, { status: 'ready', finalArtifactId: compose.id, error: null }); this.repo.event(id, 'project.ready', { revision, artifactId: compose.id });
  }
  private async execute(job: Job, fn: (path: string, productionId: string) => Promise<void>): Promise<string> {
    if (job.status === 'succeeded' && job.artifactId) {
      const path = join(this.root, this.repo.getArtifact(job.artifactId).path);
      if (!existsSync(path)) throw new AppError(409, '已完成产物丢失；停止自动重新生成以避免重复费用'); return path;
    }
    if (job.status === 'unknown') throw new UncertainSubmission();
    const resumingVideo = job.kind === 'video' && Boolean(job.providerTaskId);
    if (job.attempts >= 3 && !resumingVideo) throw new AppError(409, '该任务已达到3次尝试上限，请检查失败原因');
    const path = join(this.root, 'artifacts', job.projectId, `r${job.revision}`, `${job.id}-a${job.attempts + 1}.${job.kind === 'image' ? 'image' : 'mp4'}`);
    await mkdir(join(this.root, 'artifacts', job.projectId, `r${job.revision}`), { recursive: true });
    this.repo.updateJob(job.id, { status: 'running', attempts: job.attempts + 1, error: null }); this.repo.event(job.projectId, 'job.started', { jobId: job.id, kind: job.kind, shotId: job.shotId });
    const shot = this.repo.getProject(job.projectId).storyboard?.shots.find(s => s.id === job.shotId);
    const config = this.media.generationConfig?.(job.kind);
    const sourceBoard = this.repo.getProject(job.projectId).storyboard!;
    const archived = this.repo.production.create({ projectId: job.projectId, kind: job.kind, label: job.kind === 'compose' ? '成片拼接' : `${shot?.title ?? '镜头'} · ${job.kind === 'image' ? '预览图' : '视频'}`, status: 'running', revision: job.revision, shotId: job.shotId ?? undefined, prompt: job.kind === 'image' ? shot?.imagePrompt : job.kind === 'video' && shot ? compileVideoPrompt(sourceBoard, shot, 'text') : undefined, content: { shot, audioProfile: sourceBoard.audioProfile }, simulated: this.media.simulated, model: config?.model, parameters: { ...config?.parameters, ...(job.kind === 'video' && shot ? { duration: shot.duration, promptVersion: VIDEO_PROMPT_VERSION, audioMode: shot.audio?.mode ?? 'silent' } : {}) } });
    this.repo.production.recordOutput(job.projectId, archived.id, relative(this.root, path));
    let produced = false;
    try {
      await fn(path, archived.id); produced = true; const info = await stat(path); if (!info.size) throw new Error('Empty media file');
      if (job.kind === 'video' && shot?.audio && shot.audio.mode !== 'silent' && !(await inspectMedia(path)).hasAudio) throw new MissingAudioTrack();
      const bytes = await readFile(path); const imageMime = bytes[0] === 0xff ? 'image/jpeg' : bytes.subarray(0, 4).toString() === 'RIFF' ? 'image/webp' : 'image/png';
      const a: Artifact = { id: job.id, projectId: job.projectId, revision: job.revision, shotId: job.shotId, kind: job.kind, path: relative(this.root, path), mime: job.kind === 'image' ? imageMime : 'video/mp4', bytes: info.size,
        sha256: createHash('sha256').update(bytes).digest('hex'), simulated: this.media.simulated, createdAt: new Date().toISOString() };
      this.repo.production.update(job.projectId, archived.id, { status: 'succeeded', file: { path: a.path, bytes: a.bytes, mime: a.mime, sha256: a.sha256 }, outputId: a.id });
      this.repo.saveArtifact(a); this.repo.updateJob(job.id, { status: 'succeeded', artifactId: a.id }); this.repo.event(job.projectId, 'job.succeeded', { jobId: job.id, artifactId: a.id }); return path;
    } catch (e) {
      const failure = !this.media.simulated && job.kind === 'image' && produced ? new UncertainSubmission() : e;
      this.repo.production.update(job.projectId, archived.id, { status: failure instanceof UncertainSubmission ? 'unknown' : 'failed', error: failure instanceof AppError ? failure.message : '媒体任务失败' });
      await new ProductionService(this.repo, this.root).recoverOutputs(job.projectId);
      this.repo.updateJob(job.id, { status: failure instanceof UncertainSubmission ? 'unknown' : 'failed', error: failure instanceof AppError ? failure.message : '媒体任务失败', ...(failure instanceof ProviderFailed || failure instanceof MissingAudioTrack ? { providerTaskId: undefined } : {}) }); throw failure;
    }
  }
}
