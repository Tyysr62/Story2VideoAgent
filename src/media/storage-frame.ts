import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { AppError } from '../domain/storyboard.js';
import type { ProductionEntry } from '../production/store.js';

export function storagePrefix(value: string | undefined) {
  const prefix = value?.trim() || 'story-agent';
  if (!/^[\w/-]+$/.test(prefix) || prefix.split('/').includes('..')) throw new AppError(400, '对象存储前缀配置无效');
  return prefix;
}
export async function verifiedStorageFrame(entry: ProductionEntry, path: string, prefix: string) {
  const file = entry.file;
  if (!file || !['image/png', 'image/jpeg', 'image/webp'].includes(file.mime)) throw new AppError(400, '只能传输已确认的首帧图片');
  const bytes = await readFile(path);
  if (bytes.length !== file.bytes || bytes.length > 10 * 1024 * 1024 || createHash('sha256').update(bytes).digest('hex') !== file.sha256) throw new AppError(409, '首帧校验失败，已停止上传');
  const key = `${prefix}/${entry.projectId.replace(/[^\w-]/g, '_')}/${entry.id.replace(/[^\w-]/g, '_')}-${file.sha256}.${file.mime === 'image/jpeg' ? 'jpg' : file.mime.split('/')[1]}`;
  return { key, bytes, file };
}
