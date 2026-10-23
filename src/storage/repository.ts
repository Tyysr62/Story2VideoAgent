import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { CharacterStore } from './characters.js';
import { PortraitJobs } from './portrait-jobs.js';
import { ProductionStore } from '../production/store.js';
import { AppError, validateStoryboard, type Project, type Job, type Artifact, type ProjectEvent } from '../domain/storyboard.js';

const stamp = () => new Date().toISOString();
export class Repository {
  private db: DatabaseSync;
  readonly characters: CharacterStore;
  readonly portraits: PortraitJobs;
  readonly production: ProductionStore;
  constructor(path: string) {
    const existed = path !== ':memory:' && existsSync(path);
    mkdirSync(dirname(path), { recursive: true }); this.db = new DatabaseSync(path);
    const migrated = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='character_libraries'").get();
    // VACUUM INTO includes committed WAL state and never copies a partial live DB file.
    const hasProduction = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='production_entries'").get();
    if (existed && (!migrated || !hasProduction)) {
      const backup = `${path}.backup-${Date.now()}-${randomUUID()}`;
      try { this.db.exec(`VACUUM INTO '${backup.replaceAll("'", "''")}'`); }
      catch (error) { this.db.close(); throw error; }
    }
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY, project_id TEXT NOT NULL, logical_key TEXT UNIQUE NOT NULL, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS artifacts(id TEXT PRIMARY KEY, project_id TEXT NOT NULL, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL, type TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS character_libraries(project_id TEXT PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS character_images(id TEXT PRIMARY KEY, project_id TEXT NOT NULL, payload TEXT NOT NULL);`);
    this.production = new ProductionStore(this.db, id => this.getProject(id));
    this.characters = new CharacterStore(this.db, id => this.getProject(id), this.production);
    this.portraits = new PortraitJobs(this.db);
    for (const p of this.listProjects()) {
      this.production.archiveBoard(p, true);
      const archivedPaths = new Set(this.production.list(p.id).flatMap(e => e.file ? [e.file.path] : []));
      for (const asset of this.artifacts(p.id)) if (!archivedPaths.has(asset.path)) this.production.ensure({ id: `legacy:${asset.id}`, projectId: p.id, kind: asset.kind, label: `历史${asset.kind === 'image' ? '图片' : asset.kind === 'video' ? '视频' : '成片'}`, status: 'succeeded', revision: asset.revision, shotId: asset.shotId ?? undefined, file: { path: asset.path, mime: asset.mime, bytes: asset.bytes, sha256: asset.sha256 }, simulated: asset.simulated, createdAt: asset.createdAt, legacy: true });
      for (const asset of this.characters.images(p.id)) this.characters.archiveImage(asset);
      for (const job of this.portraits.list(p.id)) this.production.ensure({ id: `portrait-request:${job.id}`, projectId: p.id, kind: 'prompt', label: '角色生图请求', status: job.status, prompt: job.inputSnapshot?.prompt, model: job.inputSnapshot?.model, parameters: job.inputSnapshot?.parameters, content: job.inputSnapshot, characterId: job.characterId, lookId: job.lookId, outputId: job.assetId ? `character:${job.assetId}` : undefined, error: job.error ?? undefined, createdAt: job.createdAt, legacy: true });
    }
  }
  close() { this.db.close(); }
  private read<T>(row: unknown): T { return JSON.parse((row as { payload: string }).payload) as T; }
  private putProject(p: Project) { p.updatedAt = stamp(); this.db.prepare('UPDATE projects SET payload=? WHERE id=?').run(JSON.stringify(p), p.id); }
  private transaction<T>(fn: () => T): T { this.db.exec('BEGIN IMMEDIATE'); try { const v = fn(); this.db.exec('COMMIT'); return v; } catch (e) { this.db.exec('ROLLBACK'); throw e; } }
  createProject(story: string, workflowVersion?: 2): Project {
    if (!story.trim() || story.length > 20000) throw new AppError(400, '故事需要 1–20000 个字符');
    if (workflowVersion !== undefined && workflowVersion !== 2) throw new AppError(400, '不支持的工作流版本');
    const now = stamp(); const p: Project = { ...(workflowVersion === 2 ? { workflowVersion } : {}), id: randomUUID(), story: story.trim(), revision: 0, storyboard: null, status: 'draft', approvedRevision: null, finalArtifactId: null, error: null, createdAt: now, updatedAt: now };
    this.transaction(() => { this.db.prepare('INSERT INTO projects VALUES(?,?)').run(p.id, JSON.stringify(p)); this.production.archiveBoard(p); this.event(p.id, 'project.created', {}); }); return p;
  }
  listProjects(): Project[] { return this.db.prepare('SELECT payload FROM projects ORDER BY rowid DESC').all().map(r => this.read<Project>(r)); }
  getProject(id: string): Project { const row = this.db.prepare('SELECT payload FROM projects WHERE id=?').get(id); if (!row) throw new AppError(404, '项目不存在'); return this.read(row); }
  updateProject(id: string, patch: Partial<Omit<Project, 'id' | 'revision' | 'storyboard'>>): Project { const p = { ...this.getProject(id), ...patch }; this.putProject(p); return p; }
  assertRevision(p: Project, revision: number) { if (p.revision !== revision) throw new AppError(409, '项目版本已变化，请刷新后重试'); }
  saveStoryboard(id: string, revision: number, value: unknown, fromPlanner = false): Project {
    let storyboard = validateStoryboard(value);
    return this.transaction(() => {
      const p = this.getProject(id); this.assertRevision(p, revision);
      if (p.status === 'generating' || (p.workflowVersion === 2 && p.status === 'planning' && !fromPlanner)) throw new AppError(409, '规划或生成期间不能修改分镜');
      if (p.workflowVersion === 2) {
        if (fromPlanner) storyboard = this.characters.adoptPlan(id, storyboard);
        this.characters.validateStoryboard(id, storyboard);
        storyboard = { ...storyboard, characters: this.characters.snapshot(id).characters.map(c => ({ id: c.id, name: c.name, description: c.description })), shots: storyboard.shots.map(s => ({ ...s, characterIds: [...new Set((s.characterRefs ?? []).map(r => r.characterId))] })) };
        if (p.storyboard?.style !== storyboard.style) this.characters.invalidateApproval(id);
      }
      Object.assign(p, { storyboard, revision: p.revision + 1, approvedRevision: null, finalArtifactId: null, error: null, status: 'awaiting_approval' });
      this.putProject(p); this.production.archiveBoard(p); this.event(id, 'storyboard.updated', { revision: p.revision, shots: storyboard.shots.length }); return p;
    });
  }
  enableV2(id: string, revision: number): Project {
    return this.transaction(() => {
      const p = this.getProject(id); this.assertRevision(p, revision);
      if (['planning', 'generating'].includes(p.status)) throw new AppError(409, '项目正在处理');
      if (p.workflowVersion === 2) return p;
      if (p.storyboard) p.storyboard = this.characters.adoptPlan(id, p.storyboard);
      p.workflowVersion = 2; p.approvedRevision = null; p.status = p.storyboard ? 'awaiting_approval' : 'draft'; p.error = null;
      this.putProject(p); this.event(id, 'project.v2_enabled', { revision }); return p;
    });
  }
  approve(id: string, revision: number): Project {
    return this.transaction(() => {
      const p = this.getProject(id); this.assertRevision(p, revision);
      if (!p.storyboard) throw new AppError(409, '请先生成分镜');
      if (p.status === 'generating') throw new AppError(409, '项目正在生成');
      if (p.workflowVersion === 2) {
        this.characters.validateStoryboard(id, p.storyboard, true);
        if (!this.characters.snapshot(id).approval) throw new AppError(409, '请先确认角色定稿');
      }
      p.approvedRevision = revision; p.status = 'approved'; p.error = null;
      this.putProject(p); this.event(id, 'project.approved', { revision }); return p;
    });
  }
  event(projectId: string, type: string, data: unknown) { this.db.prepare('INSERT INTO events(project_id,type,payload,created_at) VALUES(?,?,?,?)').run(projectId, type, JSON.stringify(data), stamp()); }
  events(projectId: string, after = 0): ProjectEvent[] { return this.db.prepare('SELECT * FROM events WHERE project_id=? AND id>? ORDER BY id').all(projectId, after).map(row => ({ id: Number(row.id), projectId, type: String(row.type), data: JSON.parse(String(row.payload)), createdAt: String(row.created_at) })); }
  ensureJob(input: Pick<Job, 'projectId' | 'revision' | 'kind'> & { shotId?: string | null }): Job {
    const key = `${input.projectId}:${input.revision}:${input.kind}:${input.shotId ?? ''}`;
    const existing = this.db.prepare('SELECT payload FROM jobs WHERE logical_key=?').get(key); if (existing) return this.read(existing);
    const now = stamp(); const job: Job = { ...input, shotId: input.shotId ?? null, id: randomUUID(), status: 'queued', attempts: 0, artifactId: null, error: null, createdAt: now, updatedAt: now };
    this.db.prepare('INSERT INTO jobs VALUES(?,?,?,?)').run(job.id, job.projectId, key, JSON.stringify(job)); return job;
  }
  jobs(projectId: string): Job[] { return this.db.prepare('SELECT payload FROM jobs WHERE project_id=? ORDER BY rowid').all(projectId).map(r => this.read<Job>(r)); }
  getJob(id: string): Job { const row = this.db.prepare('SELECT payload FROM jobs WHERE id=?').get(id); if (!row) throw new AppError(404, '任务不存在'); return this.read(row); }
  updateJob(id: string, patch: Partial<Job>): Job { const j = { ...this.getJob(id), ...patch, updatedAt: stamp() }; this.db.prepare('UPDATE jobs SET payload=? WHERE id=?').run(JSON.stringify(j), id); return j; }
  saveArtifact(a: Artifact) { this.db.prepare('INSERT OR REPLACE INTO artifacts VALUES(?,?,?)').run(a.id, a.projectId, JSON.stringify(a)); }
  getArtifact(id: string): Artifact { const row = this.db.prepare('SELECT payload FROM artifacts WHERE id=?').get(id); if (!row) throw new AppError(404, '产物不存在'); return this.read(row); }
  artifacts(projectId: string): Artifact[] { return this.db.prepare('SELECT payload FROM artifacts WHERE project_id=? ORDER BY rowid').all(projectId).map(r => this.read<Artifact>(r)); }
}
