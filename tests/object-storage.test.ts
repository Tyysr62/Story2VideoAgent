import { test, expect } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { ObjectStorage } from '../src/media/object-storage.js';

test('own bucket receives verified bytes privately and only a short-lived GET URL is returned', async () => {
  const root = await mkdtemp(join(tmpdir(), 'story-s3-')); const sent: any[] = [];
  try {
    const bytes = Buffer.from('verified-first-frame'); const path = join(root, 'frame.png'); await writeFile(path, bytes);
    const entry: any = { id: 'frame-1', projectId: 'project-1', file: { mime: 'image/png', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') } };
    const store = new ObjectStorage({ MEDIA_S3_BUCKET: 'user-bucket', MEDIA_S3_ENDPOINT: 'https://account.r2.cloudflarestorage.com', MEDIA_S3_ACCESS_KEY_ID: 'fixture-key', MEDIA_S3_SECRET_ACCESS_KEY: 'fixture-secret', MEDIA_S3_REGION: 'auto' }, { send: async command => { sent.push(command.input); }, sign: async (_client, command, options) => { expect(options.expiresIn).toBe(3600); expect(command.input.Bucket).toBe('user-bucket'); return 'https://bucket.example/frame.png?signed=fixture'; } });
    expect(store.configured).toBe(true); expect(await store.frame(entry, path)).toContain('https://'); expect(sent).toHaveLength(1); expect(sent[0].Body).toEqual(bytes); expect(sent[0].ACL).toBeUndefined(); expect(sent[0].Metadata.sha256).toBe(entry.file.sha256);
    await writeFile(path, 'changed'); await expect(store.frame(entry, path)).rejects.toThrow(/校验/); expect(sent).toHaveLength(1);
    const missing = new ObjectStorage({}); expect(missing.configured).toBe(false); await expect(missing.frame(entry, path)).rejects.toThrow(/对象存储/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
