import { test, expect, vi } from 'vitest';
import OSS from 'ali-oss';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { AliyunOssStorage } from '../src/media/aliyun-oss.js';
import { createFrameTransport } from '../src/media/frame-transport.js';
import { ObjectStorage } from '../src/media/object-storage.js';

const env = { MEDIA_STORAGE_PROVIDER: 'oss', MEDIA_OSS_REGION: 'oss-cn-beijing', MEDIA_OSS_ENDPOINT: 'https://oss-cn-beijing.aliyuncs.com', MEDIA_OSS_BUCKET: 'test-story-bucket', MEDIA_OSS_ACCESS_KEY_ID: 'fixture-key', MEDIA_OSS_ACCESS_KEY_SECRET: 'fixture-secret' };

test('uploads verified private bytes using the real OSS client config and signs a V4 HTTPS GET locally', async () => {
  const root = await mkdtemp(join(tmpdir(), 'story-oss-')); const requests: any[] = []; let client: OSS | undefined;
  try {
    const bytes = Buffer.from('verified-first-frame'); const path = join(root, 'frame.png'); await writeFile(path, bytes);
    const entry: any = { id: 'frame-1', projectId: 'project-1', file: { mime: 'image/png', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') } };
    const store = new AliyunOssStorage(env, { client: options => {
      expect(options).toMatchObject({ authorizationV4: true, secure: true, bucket: 'test-story-bucket', region: 'oss-cn-beijing', endpoint: env.MEDIA_OSS_ENDPOINT });
      client = new OSS(options);
      vi.spyOn(client, 'put').mockImplementation(async (...args) => { requests.push(args); return {} as any; });
      return client;
    } });
    expect(store.configured).toBe(true); const url = new URL(await store.frame(entry, path));
    expect(url.origin).toBe('https://test-story-bucket.oss-cn-beijing.aliyuncs.com');
    expect(url.searchParams.get('x-oss-signature-version')).toBe('OSS4-HMAC-SHA256'); expect(url.searchParams.get('x-oss-expires')).toBe('3600');
    expect(url.searchParams.get('x-oss-credential')).toContain('/cn-beijing/oss/aliyun_v4_request'); expect(url.searchParams.get('x-oss-signature')).toMatch(/^[a-f0-9]{64}$/);
    expect(url.searchParams.has('x-oss-additional-headers')).toBe(false); expect(url.toString()).not.toContain('fixture-secret');
    expect(requests).toHaveLength(1); expect(requests[0][0]).toBe(`story-agent/project-1/frame-1-${entry.file.sha256}.png`); expect(requests[0][1]).toEqual(bytes);
    expect(requests[0][2]).toMatchObject({ mime: 'image/png', headers: { 'x-oss-meta-sha256': entry.file.sha256, 'x-oss-object-acl': 'private' } });
    await writeFile(path, Buffer.alloc(bytes.length, 0)); await expect(store.frame(entry, path)).rejects.toThrow(/校验/); expect(requests).toHaveLength(1);
  } finally { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); }
});

test('storage selection is explicit and never treats S3 credentials as native OSS credentials', async () => {
  expect(createFrameTransport({})).toBeInstanceOf(ObjectStorage);
  expect(createFrameTransport({ MEDIA_STORAGE_PROVIDER: 'oss' })).toBeInstanceOf(AliyunOssStorage);
  const missing = createFrameTransport({ MEDIA_STORAGE_PROVIDER: 'oss', MEDIA_S3_BUCKET: 's3-bucket', MEDIA_S3_ACCESS_KEY_ID: 's3-key', MEDIA_S3_SECRET_ACCESS_KEY: 's3-secret' });
  expect(missing.configured).toBe(false); await expect(missing.frame({} as any, 'unused')).rejects.toThrow(/MEDIA_OSS|OSS/);
  expect(() => createFrameTransport({ MEDIA_STORAGE_PROVIDER: 'unknown' })).toThrow(/MEDIA_STORAGE_PROVIDER/);
});

test.each([
  { MEDIA_OSS_ENDPOINT: 'http://oss-cn-beijing.aliyuncs.com' },
  { MEDIA_OSS_ENDPOINT: 'https://oss-cn-beijing-internal.aliyuncs.com' },
  { MEDIA_OSS_ENDPOINT: 'https://bucket.oss-cn-beijing.aliyuncs.com' },
  { MEDIA_OSS_ENDPOINT: 'https://oss-cn-hangzhou.aliyuncs.com' },
  { MEDIA_OSS_ENDPOINT: 'https://oss-cn-beijing.aliyuncs.com/?secret=value' },
  { MEDIA_OSS_ENDPOINT: 'https://user:password@oss-cn-beijing.aliyuncs.com' },
  { MEDIA_OSS_PREFIX: '../secrets' },
])('rejects incompatible endpoint or prefix without revealing the supplied value: %o', patch => {
  expect(() => new AliyunOssStorage({ ...env, ...patch })).toThrow(/端点|前缀|地域/);
});

test('native OSS failures are redacted and never trigger the signing step or a retry', async () => {
  const root = await mkdtemp(join(tmpdir(), 'story-oss-fail-')); let puts = 0; let signs = 0;
  try {
    const bytes = Buffer.from('frame'); const path = join(root, 'f.png'); await writeFile(path, bytes);
    const entry: any = { id: 'frame', projectId: 'project', file: { mime: 'image/png', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') } };
    const store = new AliyunOssStorage(env, { client: options => {
      const client = new OSS(options); vi.spyOn(client, 'put').mockImplementation(async () => { puts++; throw Error('fixture-secret private upstream'); });
      vi.spyOn(client, 'signatureUrlV4').mockImplementation(async () => { signs++; return 'http://invalid'; }); return client;
    } });
    await expect(store.frame(entry, path)).rejects.toThrow(/OSS 上传或签名失败/); expect(puts).toBe(1); expect(signs).toBe(0);
  } finally { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); }
});


test('the actual OSS upload transport emits OSS4 authorization and private object headers', async () => {
  const root = await mkdtemp(join(tmpdir(), 'story-oss-wire-')); const requests: any[] = [];
  try {
    const bytes = Buffer.from('first-frame'); const path = join(root, 'f.png'); await writeFile(path, bytes);
    const entry: any = { id: 'frame', projectId: 'project', file: { mime: 'image/png', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') } };
    const store = new AliyunOssStorage(env, { client: options => {
      const clientOptions = { ...options, urllib: { request: async (url: string, request: any) => {
        requests.push({ url, request }); return { status: 200, headers: { etag: 'fixture', 'x-oss-request-id': 'fixture' }, data: Buffer.alloc(0), res: { status: 200, headers: {} } };
      } } }; return new OSS(clientOptions);
    } });
    await store.frame(entry, path); expect(requests).toHaveLength(1);
    const { url, request } = requests[0]; const headers = new Headers(request.headers);
    expect(new URL(url).origin).toBe('https://test-story-bucket.oss-cn-beijing.aliyuncs.com'); expect(request.method).toBe('PUT');
    expect(headers.get('authorization')).toMatch(/^OSS4-HMAC-SHA256 /); expect(headers.get('x-oss-object-acl')).toBe('private'); expect(headers.get('x-oss-meta-sha256')).toBe(entry.file.sha256);
    expect(headers.get('content-type')).toBe('image/png'); expect(request.content).toEqual(bytes);
  } finally { await rm(root, { recursive: true, force: true }); }
});
