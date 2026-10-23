import type { DatabaseSync } from 'node:sqlite';
import { AppError } from '../domain/storyboard.js';
import type { GenerationSnapshot } from '../domain/characters.js';

export interface PortraitJob {
  id: string; projectId: string; characterId: string; lookId: string; lookVersionId: string; libraryRevision: number;
  inputHash: string; status: 'running' | 'succeeded' | 'failed' | 'unknown'; assetId: string | null;
  error: string | null; createdAt: string; updatedAt: string;
  inputSnapshot?: GenerationSnapshot;
}
export class PortraitJobs {
  constructor(private db: DatabaseSync) {
    db.exec('CREATE TABLE IF NOT EXISTS portrait_jobs(id TEXT PRIMARY KEY, project_id TEXT NOT NULL, payload TEXT NOT NULL)');
  }
  list(projectId: string): PortraitJob[] { return this.db.prepare('SELECT payload FROM portrait_jobs WHERE project_id=? ORDER BY rowid').all(projectId).map(r => JSON.parse(String(r.payload))); }
  get(projectId: string, id: string): PortraitJob | undefined {
    const row = this.db.prepare('SELECT payload FROM portrait_jobs WHERE project_id=? AND id=?').get(projectId, id);
    return row ? JSON.parse(String(row.payload)) : undefined;
  }
  create(job: PortraitJob) { this.db.prepare('INSERT INTO portrait_jobs VALUES(?,?,?)').run(job.id, job.projectId, JSON.stringify(job)); return job; }
  update(projectId: string, id: string, patch: Pick<PortraitJob, 'status' | 'assetId' | 'error'>) {
    const job = this.get(projectId, id); if (!job) throw new AppError(404, '角色图片任务不存在');
    const next = { ...job, ...patch, updatedAt: new Date().toISOString() };
    this.db.prepare('UPDATE portrait_jobs SET payload=? WHERE project_id=? AND id=?').run(JSON.stringify(next), projectId, id); return next;
  }
}
