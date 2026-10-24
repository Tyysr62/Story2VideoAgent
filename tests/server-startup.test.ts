import { test, expect } from 'vitest';
import { createServer } from 'node:net';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';

test('an occupied port stops startup before opening or recovering the production database', async () => {
  const server = createServer(); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw Error('Missing port');
  const root = await mkdtemp(join(tmpdir(), 'story-startup-')); const path = join(root, 'story.db'); const original = Buffer.from('untouched-production-db'); await writeFile(path, original);
  try {
    const result = await promisify(execFile)(process.execPath, ['--import', 'tsx', 'src/server/main.ts', '--demo'], {
      cwd: process.cwd(), env: { ...process.env, PORT: String(address.port), STORY_AGENT_DATA_DIR: root }, timeout: 20000,
    }).catch(error => error);
    expect(result.code).not.toBe(0); expect(result.stderr).toContain('EADDRINUSE');
    expect(await readFile(path)).toEqual(original);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  }
}, 30000);
