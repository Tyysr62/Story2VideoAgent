import { AppError } from '../domain/storyboard.js';
import { ObjectStorage } from './object-storage.js';
import { AliyunOssStorage } from './aliyun-oss.js';

export function createFrameTransport(env: Record<string, string | undefined> = process.env) {
  const provider = env.MEDIA_STORAGE_PROVIDER?.trim() || 's3';
  if (provider === 'oss') return new AliyunOssStorage(env);
  if (provider === 's3') return new ObjectStorage(env);
  throw new AppError(400, 'MEDIA_STORAGE_PROVIDER 仅支持 oss / s3');
}
