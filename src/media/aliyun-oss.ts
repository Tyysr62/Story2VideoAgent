import OSS from 'ali-oss';
import { AppError } from '../domain/storyboard.js';
import type { ProductionEntry } from '../production/store.js';
import type { FrameTransport } from '../production/m2.js';
import { storagePrefix, verifiedStorageFrame } from './storage-frame.js';

interface Overrides { client?(options: OSS.Options): OSS; }
/** Native OSS V4 signatures are separate from the S3 signing protocol. */
export class AliyunOssStorage implements FrameTransport {
  readonly configured: boolean;
  private client?: OSS; private prefix: string; private host = '';
  constructor(env: Record<string, string | undefined> = process.env, overrides: Overrides = {}) {
    const bucket = env.MEDIA_OSS_BUCKET?.trim() || ''; const region = env.MEDIA_OSS_REGION?.trim() || '';
    const accessKeyId = env.MEDIA_OSS_ACCESS_KEY_ID?.trim() || ''; const accessKeySecret = env.MEDIA_OSS_ACCESS_KEY_SECRET?.trim() || '';
    this.prefix = storagePrefix(env.MEDIA_OSS_PREFIX);
    this.configured = Boolean(bucket && region && accessKeyId && accessKeySecret);
    if (!this.configured) return;
    if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket)) throw new AppError(400, 'OSS Bucket 名称配置无效');
    if (!/^oss-[a-z0-9]+(?:-[a-z0-9]+)+$/.test(region) || region.includes('internal')) throw new AppError(400, 'OSS 地域应填写 oss-cn-beijing 等公网地域');
    let endpoint: URL;
    try { endpoint = new URL(env.MEDIA_OSS_ENDPOINT?.trim() || `https://${region}.aliyuncs.com`); }
    catch { throw new AppError(400, 'OSS 端点配置无效'); }
    if (endpoint.protocol !== 'https:' || endpoint.hostname !== `${region}.aliyuncs.com` || endpoint.port || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== '/') throw new AppError(400, 'OSS 端点必须为与地域匹配的标准公网 HTTPS Endpoint，不含 Bucket、路径或凭据');
    this.host = `${bucket}.${endpoint.hostname}`;
    const options = { accessKeyId, accessKeySecret, bucket, region, endpoint: endpoint.origin, authorizationV4: true, secure: true, timeout: 60000, retryMax: 0, ...(env.MEDIA_OSS_STS_TOKEN?.trim() ? { stsToken: env.MEDIA_OSS_STS_TOKEN.trim() } : {}) };
    this.client = (overrides.client ?? (options => new OSS(options)))(options);
  }
  async frame(entry: ProductionEntry, path: string): Promise<string> {
    if (!this.configured || !this.client) throw new AppError(503, '请先配置 MEDIA_OSS_REGION、MEDIA_OSS_BUCKET、MEDIA_OSS_ACCESS_KEY_ID 与 MEDIA_OSS_ACCESS_KEY_SECRET；未提交视频费用');
    const { key, bytes, file } = await verifiedStorageFrame(entry, path, this.prefix);
    try {
      await this.client.put(key, bytes, { mime: file.mime, headers: { 'x-oss-meta-sha256': file.sha256, 'x-oss-object-acl': 'private' } });
      // No signed request headers: the cloud video provider only receives this URL.
      const url = await this.client.signatureUrlV4('GET', 3600, undefined, key);
      const parsed = new URL(url);
      if (parsed.protocol !== 'https:' || parsed.host !== this.host || parsed.username || parsed.password) throw Error('Invalid OSS URL');
      return url;
    } catch { throw new AppError(502, 'OSS 上传或签名失败，请检查本地密钥、桶地域及 PutObject/GetObject 权限；未向视频模型提交该首帧'); }
  }
}
