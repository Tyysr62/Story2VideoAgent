import { defineConfig } from '@playwright/test';
import { resolve } from 'node:path';
export default defineConfig({
  testDir: './tests/e2e', fullyParallel: false, workers: 1, timeout: 90000,
  expect: { timeout: 20000 }, reporter: 'list',
  // Branded browsers include H.264 support; Playwright's headless shell does not.
  use: { baseURL: 'http://127.0.0.1:4321', channel: process.env.PLAYWRIGHT_CHANNEL || (process.platform === 'win32' ? 'msedge' : 'chrome'), viewport: { width: 1440, height: 1000 }, trace: 'retain-on-failure' },
  webServer: [
    { command: 'npm run demo', url: 'http://127.0.0.1:4321/api/health', timeout: 90000, reuseExistingServer: false,
      env: { PORT: '4321', STORY_AGENT_DATA_DIR: resolve('data/e2e'), OPENROUTER_API_KEY: '', DEEPSEEK_API_KEY: '' } },
    { command: 'npm start', url: 'http://127.0.0.1:4322/api/health', timeout: 90000, reuseExistingServer: false,
      env: { PORT: '4322', STORY_AGENT_DATA_DIR: resolve('data/e2e-unconfigured'), OPENROUTER_API_KEY: '', DEEPSEEK_API_KEY: '' } },
  ],
});
