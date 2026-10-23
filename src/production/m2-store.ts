import type { DatabaseSync } from 'node:sqlite';
import { AppError } from '../domain/storyboard.js';
export interface M2State { keyframes: Record<string, string>; videos: Record<string, string>; approval?: { hash: string; at: string }; finalId?: string; }
export class M2Store {
  constructor(private db: DatabaseSync) { db.exec('CREATE TABLE IF NOT EXISTS m2_state(project_id TEXT PRIMARY KEY, payload TEXT NOT NULL); CREATE TABLE IF NOT EXISTS m2_requests(id TEXT PRIMARY KEY, project_id TEXT NOT NULL, input_hash TEXT NOT NULL)'); }
  get(id: string): M2State { const r = this.db.prepare('SELECT payload FROM m2_state WHERE project_id=?').get(id); return r ? JSON.parse(String(r.payload)) : { keyframes: {}, videos: {} }; }
  save(id: string, state: M2State) { this.db.prepare('INSERT INTO m2_state VALUES(?,?) ON CONFLICT(project_id) DO UPDATE SET payload=excluded.payload').run(id, JSON.stringify(state)); }
  request(id: string, requestId: string, hash: string) { const r = this.db.prepare('SELECT * FROM m2_requests WHERE id=?').get(requestId); if (!r) return false; if (r.project_id !== id || r.input_hash !== hash) throw new AppError(409, '请求编号已用于其他生产输入'); return true; }
  begin(id: string, requestId: string, hash: string) { this.db.prepare('INSERT INTO m2_requests VALUES(?,?,?)').run(requestId, id, hash); }
}
