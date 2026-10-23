import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { AppError, type Project, type Storyboard } from '../domain/storyboard.js';

export type ProductionKind = 'storyboard' | 'prompt' | 'portrait' | 'upload' | 'image' | 'keyframe' | 'video' | 'compose';
export interface ProductionFile { path: string; mime: string; bytes: number; sha256: string; }
export interface ProductionEntry {
  id: string; projectId: string; kind: ProductionKind; label: string;
  status: 'running' | 'succeeded' | 'failed' | 'unknown'; prompt: string | null;
  model?: string; parameters: Record<string, unknown>; dependencies: string[];
  revision?: number; shotId?: string; characterId?: string; lookId?: string; inputHash?: string;
  content?: unknown; file?: ProductionFile; outputId?: string; providerTaskId?: string; providerTerminal?: boolean; error?: string;
  outputPaths?: string[];
  simulated?: boolean; legacy?: boolean; createdAt: string; updatedAt: string;
}
type Input = Omit<ProductionEntry, 'id' | 'createdAt' | 'updatedAt' | 'prompt' | 'parameters' | 'dependencies'> & { id?: string; createdAt?: string; prompt?: string | null; parameters?: Record<string, unknown>; dependencies?: string[] };
type Result = Partial<Pick<ProductionEntry, 'status' | 'file' | 'outputId' | 'providerTaskId' | 'providerTerminal' | 'error'>>;
export class ProductionStore {
  constructor(private db: DatabaseSync, private project: (id: string) => Project) {
    db.exec('CREATE TABLE IF NOT EXISTS production_entries(id TEXT PRIMARY KEY, project_id TEXT NOT NULL, payload TEXT NOT NULL); CREATE INDEX IF NOT EXISTS production_project ON production_entries(project_id)');
  }
  create(input: Input): ProductionEntry {
    this.project(input.projectId); const now = new Date().toISOString();
    const entry: ProductionEntry = { prompt: null, parameters: {}, dependencies: [], ...input, id: input.id ?? randomUUID(), createdAt: input.createdAt ?? now, updatedAt: now };
    this.db.prepare('INSERT INTO production_entries VALUES(?,?,?)').run(entry.id, entry.projectId, JSON.stringify(entry)); return structuredClone(entry);
  }
  ensure(input: Input & { id: string }) {
    const row = this.db.prepare('SELECT project_id,payload FROM production_entries WHERE id=?').get(input.id);
    if (row) { if (row.project_id !== input.projectId) throw new AppError(409, '生产记录编号冲突'); return JSON.parse(String(row.payload)) as ProductionEntry; }
    return this.create(input);
  }
  list(projectId: string): ProductionEntry[] { this.project(projectId); return this.db.prepare('SELECT payload FROM production_entries WHERE project_id=? ORDER BY rowid').all(projectId).map(r => JSON.parse(String(r.payload))); }
  get(projectId: string, id: string): ProductionEntry {
    this.project(projectId); const row = this.db.prepare('SELECT payload FROM production_entries WHERE project_id=? AND id=?').get(projectId, id);
    if (!row) throw new AppError(404, '生产记录不属于当前项目'); return JSON.parse(String(row.payload));
  }
  update(projectId: string, id: string, result: Result) {
    const entry = this.get(projectId, id);
    for (const key of ['status', 'file', 'outputId', 'providerTaskId', 'providerTerminal', 'error'] as const) if (Object.hasOwn(result, key)) (entry as any)[key] = result[key];
    entry.updatedAt = new Date().toISOString(); this.db.prepare('UPDATE production_entries SET payload=? WHERE id=? AND project_id=?').run(JSON.stringify(entry), id, projectId); return entry;
  }
  recordOutput(projectId: string, id: string, path: string) {
    const entry = this.get(projectId, id); entry.outputPaths = [...new Set([...(entry.outputPaths ?? []), path])];
    this.db.prepare('UPDATE production_entries SET payload=? WHERE id=? AND project_id=?').run(JSON.stringify(entry), id, projectId);
  }
  archiveBoard(project: Project, legacy = false) {
    this.ensure({ id: `story:${project.id}`, projectId: project.id, kind: 'prompt', label: '故事原文', status: 'succeeded', prompt: project.story, createdAt: project.createdAt });
    const b: Storyboard | null = project.storyboard; if (!b) return;
    const id = `board:${project.id}:r${project.revision}`;
    this.ensure({ id, projectId: project.id, kind: 'storyboard', label: `分镜第 ${project.revision} 版`, revision: project.revision, status: 'succeeded', content: b, legacy });
    for (const s of b.shots) for (const kind of ['image', 'video'] as const) this.ensure({ id: `${id}:${s.id}:${kind}`, projectId: project.id, kind: 'prompt', label: `${s.title} · ${kind === 'image' ? '图像' : '视频'} Prompt`, revision: project.revision, shotId: s.id, status: 'succeeded', prompt: kind === 'image' ? s.imagePrompt : s.videoPrompt, dependencies: [id], content: { style: b.style, shot: s }, legacy });
  }
}
