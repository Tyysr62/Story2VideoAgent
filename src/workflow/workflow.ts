import { readFile, stat, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { AppError, type Project, type Job, type Storyboard, type Artifact } from '../domain/storyboard.js';
import { Repository } from '../storage/repository.js';
import type { Planner } from '../director/pi-director.js';
import type { Composer, MediaBackend } from '../media/ffmpeg.js';
import { UncertainSubmission, ProviderFailed } from '../media/openrouter.js';

type Backend = MediaBackend & { validate?(board: Storyboard): Promise<void>; estimate?(board: Storyboard): Promise<unknown>; };
export class Workflow {
  private active = new Map<string, Promise<void>>();
  constructor(readonly repo: Repository, private planner: Planner, readonly media: Backend, private composer: Composer, readonly root: string) {}
  async plan(id: string, revision: number): Promise<Project> {
    const p = this.repo.getProject(id); this.repo.assertRevision(p, revision);
    if (['generating', 'planning'].includes(p.status)) throw new AppError(409, '项目正在处理，请等待当前任务完成');
    this.repo.updateProject(id, { status: 'planning', approvedRevision: null, error: null }); this.repo.event(id, 'planning.started', { revision });
    try { const board = await this.planner.plan(p.story); return this.repo.saveStoryboard(id, revision, board); }
    catch (e) {
      const message = e instanceof AppError ? e.message : '分镜规划失败，请重试';
      const current = this.repo.getProject(id);
      if (current.revision === revision && current.status === 'planning') this.repo.updateProject(id, { status: 'failed', error: message });
      this.repo.event(id, 'planning.failed', { revision, message }); throw e instanceof AppError ? e : new AppError(502, message);
    }
  }
  async estimate(id: string) {
    const p = this.repo.getProject(id); if (!p.storyboard) throw new AppError(409, '请先生成分镜');
    return this.media.estimate ? this.media.estimate(p.storyboard) : { simulated: true, shots: p.storyboard.shots.length, videoUsd: 0, imageUsd: 0, note: '仅测试模拟，不产生费用' };
  }
  async start(id: string, revision: number): Promise<Project> {
    let p = this.repo.getProject(id); this.repo.assertRevision(p, revision);
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
      if (p.status === 'planning') { this.repo.updateProject(p.id, { status: 'failed', error: '分镜规划被中断，请重新发起规划' }); continue; }
      if (p.status !== 'generating') continue;
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
    for (const shot of p.storyboard!.shots) {
      const image = this.repo.ensureJob({ projectId: id, revision, kind: 'image', shotId: shot.id });
      await this.execute(image, path => this.media.image(shot, path));
      const video = this.repo.ensureJob({ projectId: id, revision, kind: 'video', shotId: shot.id });
      const path = await this.execute(video, path => this.media.video(shot, path, { providerTaskId: video.providerTaskId, persistTaskId: providerTaskId => { this.repo.updateJob(video.id, { providerTaskId }); } }));
      videos.push(path);
    }
    const compose = this.repo.ensureJob({ projectId: id, revision, kind: 'compose', shotId: null });
    await this.execute(compose, path => this.composer.compose(videos, path));
    const current = this.repo.getProject(id); this.repo.assertRevision(current, revision);
    if (current.status !== 'generating' || current.approvedRevision !== revision) throw new AppError(409, '执行版本或确认状态已变化，停止发布成片');
    this.repo.updateProject(id, { status: 'ready', finalArtifactId: compose.id, error: null }); this.repo.event(id, 'project.ready', { revision, artifactId: compose.id });
  }
  private async execute(job: Job, fn: (path: string) => Promise<void>): Promise<string> {
    if (job.status === 'succeeded' && job.artifactId) {
      const path = join(this.root, this.repo.getArtifact(job.artifactId).path);
      if (!existsSync(path)) throw new AppError(409, '已完成产物丢失；停止自动重新生成以避免重复费用'); return path;
    }
    if (job.status === 'unknown') throw new UncertainSubmission();
    const resumingVideo = job.kind === 'video' && Boolean(job.providerTaskId);
    if (job.attempts >= 3 && !resumingVideo) throw new AppError(409, '该任务已达到3次尝试上限，请检查失败原因');
    const path = join(this.root, 'artifacts', job.projectId, `r${job.revision}`, `${job.id}.${job.kind === 'image' ? 'image' : 'mp4'}`);
    await mkdir(join(this.root, 'artifacts', job.projectId, `r${job.revision}`), { recursive: true });
    this.repo.updateJob(job.id, { status: 'running', attempts: job.attempts + 1, error: null }); this.repo.event(job.projectId, 'job.started', { jobId: job.id, kind: job.kind, shotId: job.shotId });
    let produced = false;
    try {
      await fn(path); produced = true; const info = await stat(path); if (!info.size) throw new Error('Empty media file');
      const bytes = await readFile(path); const imageMime = bytes[0] === 0xff ? 'image/jpeg' : bytes.subarray(0, 4).toString() === 'RIFF' ? 'image/webp' : 'image/png';
      const a: Artifact = { id: job.id, projectId: job.projectId, revision: job.revision, shotId: job.shotId, kind: job.kind, path: relative(this.root, path), mime: job.kind === 'image' ? imageMime : 'video/mp4', bytes: info.size,
        sha256: createHash('sha256').update(bytes).digest('hex'), simulated: this.media.simulated, createdAt: new Date().toISOString() };
      this.repo.saveArtifact(a); this.repo.updateJob(job.id, { status: 'succeeded', artifactId: a.id }); this.repo.event(job.projectId, 'job.succeeded', { jobId: job.id, artifactId: a.id }); return path;
    } catch (e) {
      const failure = !this.media.simulated && job.kind === 'image' && produced ? new UncertainSubmission() : e;
      this.repo.updateJob(job.id, { status: failure instanceof UncertainSubmission ? 'unknown' : 'failed', error: failure instanceof AppError ? failure.message : '媒体任务失败', ...(failure instanceof ProviderFailed ? { providerTaskId: undefined } : {}) }); throw failure;
    }
  }
}
