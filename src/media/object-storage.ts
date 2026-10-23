import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { AppError } from '../domain/storyboard.js';
import type { ProductionEntry } from '../production/store.js';
import type { FrameTransport } from '../production/m2.js';

interface Overrides { send?(command: PutObjectCommand): Promise<unknown>; sign?(client: S3Client, command: GetObjectCommand, options: { expiresIn: number }): Promise<string>; }
export class ObjectStorage implements FrameTransport {
  readonly configured: boolean;
  private client?: S3Client; private bucket: string; private prefix: string;
  constructor(env: Record<string, string | undefined> = process.env, private overrides: Overrides = {}) {
    this.bucket = env.MEDIA_S3_BUCKET?.trim() ?? ''; this.prefix = env.MEDIA_S3_PREFIX?.trim() || 'story-agent';
    this.configured = Boolean(this.bucket && env.MEDIA_S3_ACCESS_KEY_ID && env.MEDIA_S3_SECRET_ACCESS_KEY);
    if (!this.configured) return;
    if (!/^[\w/-]+$/.test(this.prefix) || this.prefix.split('/').includes('..')) throw new AppError(400, '对象存储前缀配置无效');
    if (env.MEDIA_S3_ENDPOINT) { let url: URL; try { url = new URL(env.MEDIA_S3_ENDPOINT); } catch { throw new AppError(400, '对象存储端点配置无效'); } if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new AppError(400, '对象存储端点必须为不含凭据的 HTTPS 地址'); }
    this.client = new S3Client({ region: env.MEDIA_S3_REGION || 'us-east-1', ...(env.MEDIA_S3_ENDPOINT ? { endpoint: env.MEDIA_S3_ENDPOINT } : {}), forcePathStyle: env.MEDIA_S3_FORCE_PATH_STYLE === 'true', credentials: { accessKeyId: env.MEDIA_S3_ACCESS_KEY_ID!, secretAccessKey: env.MEDIA_S3_SECRET_ACCESS_KEY! }, maxAttempts: 1, requestHandler: { requestTimeout: 60000, connectionTimeout: 15000 } });
  }
  async frame(entry: ProductionEntry, path: string): Promise<string> {
    if (!this.configured || !this.client) throw new AppError(503, '请先配置自有对象存储，未提交视频费用');
    const file = entry.file; if (!file || !['image/png', 'image/jpeg', 'image/webp'].includes(file.mime)) throw new AppError(400, '只能传输已确认的首帧图片');
    const bytes = await readFile(path); if (bytes.length !== file.bytes || bytes.length > 10 * 1024 * 1024 || createHash('sha256').update(bytes).digest('hex') !== file.sha256) throw new AppError(409, '首帧校验失败，已停止上传');
    const key = `${this.prefix}/${entry.projectId.replace(/[^\w-]/g, '_')}/${entry.id.replace(/[^\w-]/g, '_')}-${file.sha256}.${file.mime === 'image/jpeg' ? 'jpg' : file.mime.split('/')[1]}`;
    try {
      const put = new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: bytes, ContentType: file.mime, Metadata: { sha256: file.sha256 } });
      await (this.overrides.send ? this.overrides.send(put) : this.client.send(put));
      const url = await (this.overrides.sign ?? getSignedUrl)(this.client, new GetObjectCommand({ Bucket: this.bucket, Key: key }), { expiresIn: 3600 });
      if (new URL(url).protocol !== 'https:') throw Error('Invalid signed URL'); return url;
    } catch { throw new AppError(502, '对象存储上传或签名失败，请检查本地配置与桶权限；未向视频模型提交该首帧'); }
  }
}
