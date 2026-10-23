import { createReadStream } from 'node:fs';
import { realpath, stat, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, relative, isAbsolute } from 'node:path';
import { ZipFile } from 'yazl';
import { AppError } from '../domain/storyboard.js';
import type { Repository } from '../storage/repository.js';
import type { ProductionEntry } from './store.js';
import { validatePortrait } from '../characters/images.js';

export function publicEntry(entry: ProductionEntry) {
  const { file, outputPaths: _outputPaths, ...data } = entry;
  return { ...data, ...(file ? { file: { mime: file.mime, bytes: file.bytes, sha256: file.sha256 }, url: `/api/projects/${encodeURIComponent(entry.projectId)}/production/${encodeURIComponent(entry.id)}/file` } : {}) };
}
export class ProductionService {
  constructor(readonly repo: Repository, readonly root: string) {}
  list(id: string) { const project = this.repo.getProject(id); return { project: { id, title: project.storyboard?.title ?? project.story.slice(0, 40) }, entries: this.repo.production.list(id).map(publicEntry) }; }
  private async locate(path: string) {
    const root = await realpath(this.root); const target = resolve(root, path); const rel = relative(root, target);
    if (!rel || rel.startsWith('..') || isAbsolute(rel) || /(^|[\\/])(diagnostics|\.env[^\\/]*)([\\/]|$)|\.(db|sqlite)([.-]|$)/i.test(rel)) throw new AppError(403, '生产素材路径无效');
    let actual: string; try { actual = await realpath(target); } catch { throw new AppError(404, '素材文件已丢失，已保留生产记录'); }
    const resolved = relative(root, actual); if (resolved.startsWith('..') || isAbsolute(resolved)) throw new AppError(403, '素材链接超出项目数据目录');
    return actual;
  }
  async file(projectId: string, id: string) {
    const entry = this.repo.production.get(projectId, id); if (!entry.file) throw new AppError(404, '这条生产记录没有媒体文件');
    const actual = await this.locate(entry.file.path);
    const info = await stat(actual); if (!info.isFile() || info.size !== entry.file.bytes) throw new AppError(409, '素材文件大小不一致，停止导出该文件');
    const hash = createHash('sha256'); for await (const chunk of createReadStream(actual)) hash.update(chunk);
    if (hash.digest('hex') !== entry.file.sha256) throw new AppError(409, '素材摘要校验失败，停止导出该文件');
    return { entry, path: actual };
  }
  async recoverOutputs(projectId: string) {
    const entries = this.repo.production.list(projectId); const archived = new Set(entries.flatMap(e => e.file ? [e.file.path] : []));
    for (const entry of entries) for (const path of entry.outputPaths ?? []) {
      if (entry.kind === 'prompt' && entry.status === 'succeeded' && entry.outputId) continue;
      if (archived.has(path)) continue;
      let actual: string; try { actual = await this.locate(path); } catch (error) { if (error instanceof AppError && error.status === 404) continue; throw error; }
      const info = await stat(actual); if (!info.isFile() || !info.size) continue;
      const hash = createHash('sha256'); for await (const chunk of createReadStream(actual)) hash.update(chunk);
      let mime = 'application/octet-stream';
      if (['keyframe', 'portrait', 'image', 'prompt'].includes(entry.kind) && info.size <= 10 * 1024 * 1024) {
        const bytes = await readFile(actual); const declared = bytes[0] === 255 ? 'image/jpeg' : bytes.toString('ascii', 0, 4) === 'RIFF' ? 'image/webp' : 'image/png';
        try { mime = (await validatePortrait(bytes, declared)).mime; } catch { /* Preserve undecodable output as a binary file. */ }
      }
      this.repo.production.ensure({ id: `recovered:${createHash('sha256').update(entry.id + path).digest('hex')}`, projectId, kind: entry.kind, label: `${entry.label} · 中断或失败时保存的输出`, status: 'unknown', prompt: entry.prompt, model: entry.model, parameters: entry.parameters, dependencies: [entry.id], file: { path, mime, bytes: info.size, sha256: hash.digest('hex') }, simulated: entry.simulated, error: '已找回生成文件，尚未作为可用产物确认；不会自动重新生成' });
      archived.add(path);
    }
  }
  async export(projectId: string) {
    const project = this.repo.getProject(projectId); const entries = this.repo.production.list(projectId); const zip = new ZipFile();
    const manifest: Record<string, unknown>[] = []; const files: { path: string; name: string }[] = [];
    for (const entry of entries) {
      const key = createHash('sha256').update(entry.id).digest('hex'); const clean = publicEntry(entry); const { url: _url, ...record } = clean;
      let availability = entry.file ? 'missing' : 'metadata'; let archivePath: string | undefined;
      if (entry.file) {
        try {
          const verified = await this.file(projectId, entry.id);
          const ext = ({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'video/mp4': 'mp4' } as Record<string, string>)[entry.file.mime] ?? 'bin';
          archivePath = `${ext === 'mp4' ? 'videos' : ext === 'bin' ? 'files' : 'images'}/${key}.${ext}`;
          files.push({ path: verified.path, name: archivePath }); availability = 'available';
        } catch (error) { availability = error instanceof AppError && error.status === 403 ? 'blocked' : error instanceof AppError && error.status === 409 ? 'corrupt' : 'missing'; }
      }
      const item = { ...record, ...(record.file ? { file: { ...record.file, archivePath } } : {}), availability, recordPath: `records/${key}.json`, ...(entry.prompt ? { promptPath: `prompts/${key}.txt` } : {}) };
      manifest.push(item); zip.addBuffer(Buffer.from(JSON.stringify(item, null, 2)), `records/${key}.json`);
      if (entry.prompt) zip.addBuffer(Buffer.from(`${entry.label}\n\n${entry.prompt}${entry.content && typeof entry.content === 'object' && 'systemPrompt' in entry.content ? `\n\n--- System Prompt ---\n${String(entry.content.systemPrompt)}` : ''}`, 'utf8'), `prompts/${key}.txt`);
    }
    zip.addBuffer(Buffer.from(JSON.stringify({ schemaVersion: 1, exportedAt: new Date().toISOString(), project, characterLibrary: this.repo.characters.snapshot(projectId), entries: manifest, note: '项目生产库时间点快照；metadata 无媒体，missing 文件丢失，corrupt 校验失败，blocked 路径拒绝。历史缺失 Prompt 不补造。' }, null, 2)), 'manifest.json');
    for (const file of files) zip.addFile(file.path, file.name, { compress: false });
    zip.on('error', () => { (zip.outputStream as any).destroy(new Error('项目导出读取失败')); });
    zip.end(); return { stream: zip.outputStream, title: project.storyboard?.title ?? '故事项目' };
  }
}
