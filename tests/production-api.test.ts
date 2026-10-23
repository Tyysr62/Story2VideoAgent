import { test, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { unzipSync, strFromU8 } from 'fflate';
import { Repository } from '../src/storage/repository.js';
import { Workflow } from '../src/workflow/workflow.js';
import { MockMedia, FfmpegComposer } from '../src/media/ffmpeg.js';
import { createApp } from '../src/server/app.js';
import { board } from './fixtures.js';

test('project archive exports actual media and all historical prompts, scoped downloads and manifest', async () => {
  const root = await mkdtemp(join(tmpdir(), 'production-export-')); const repo = new Repository(join(root, 'app.db'));
  const workflow = new Workflow(repo, { plan: async () => board(1) }, new MockMedia(), new FfmpegComposer(), root);
  const app = await createApp({ repo, workflow, dataRoot: root, publicConfig: {} });
  try {
    const p = repo.createProject('一叠旧信'); repo.saveStoryboard(p.id, 0, board(1)); const other = repo.createProject('另一个项目');
    await mkdir(join(root, 'media'), { recursive: true }); const bytes = Buffer.from('fixture-video'); await writeFile(join(root, 'media', 'v.mp4'), bytes);
    const file = repo.production.create({ projectId: p.id, kind: 'video', label: '重逢', status: 'succeeded', prompt: '镜头缓缓拉近', model: 'fixture', file: { path: 'media/v.mp4', bytes: bytes.length, mime: 'video/mp4', sha256: createHash('sha256').update(bytes).digest('hex') } });
    repo.production.create({ projectId: p.id, kind: 'prompt', label: '失败请求', status: 'failed', prompt: '保留这次失败的输入', error: '模拟失败' });
    const list = await app.inject(`/api/projects/${p.id}/production`); expect(list.statusCode).toBe(200); expect(list.json().entries.some((e: any) => e.id === file.id)).toBe(true); expect(JSON.stringify(list.json())).not.toContain('media/v.mp4');
    const single = await app.inject(`/api/projects/${p.id}/production/${encodeURIComponent(file.id)}/file`); expect(single.rawPayload).toEqual(bytes);
    expect((await app.inject(`/api/projects/${other.id}/production/${file.id}/file`)).statusCode).toBe(404);
    const exported = await app.inject(`/api/projects/${p.id}/production/export`); expect(exported.statusCode).toBe(200);
    const archive = unzipSync(exported.rawPayload); const manifest = JSON.parse(strFromU8(archive['manifest.json']));
    expect(manifest.project.story).toBe('一叠旧信'); const record = manifest.entries.find((e: any) => e.id === file.id); expect(Buffer.from(archive[record.file.archivePath])).toEqual(bytes);
    expect(Object.keys(archive).some(path => path.startsWith('prompts/'))).toBe(true); expect(strFromU8(archive['manifest.json'])).toContain('保留这次失败的输入');
    expect(JSON.stringify(manifest)).not.toContain(root); expect(Object.keys(archive).some(k => /\.env|\.db|diagnostics/.test(k))).toBe(false);
    await writeFile(join(root, 'media', 'v.mp4'), 'tampered'); expect((await app.inject(`/api/projects/${p.id}/production/${file.id}/file`)).statusCode).toBe(409);
    const missing = await app.inject(`/api/projects/${p.id}/production/export`); const missingManifest = JSON.parse(strFromU8(unzipSync(missing.rawPayload)['manifest.json'])); expect(missingManifest.entries.find((e: any) => e.id === file.id).availability).toBe('corrupt');
    const escaped = repo.production.create({ projectId: p.id, kind: 'image', label: 'bad', status: 'succeeded', file: { path: '../private.env', bytes: 1, mime: 'image/png', sha256: 'bad' } });
    expect((await app.inject(`/api/projects/${p.id}/production/${escaped.id}/file`)).statusCode).toBe(403);
  } finally { await app.close(); repo.close(); await rm(root, { recursive: true, force: true }); }
});
