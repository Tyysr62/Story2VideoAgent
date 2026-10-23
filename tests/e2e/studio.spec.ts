import { test, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';

test('studio completes edit → version approval → actual playable composition', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto('/');
  await expect(page.getByText('离线联调模式：', { exact: false })).toBeVisible();
  await mkdir('docs/screenshots', { recursive: true });
  await page.screenshot({ path: 'docs/screenshots/v1-home.png', fullPage: true });
  await page.getByLabel('你的故事 / 创作要求').fill('一只狐狸在月光下经营邮局。');
  await page.getByRole('button', { name: '开始规划分镜' }).click();
  await expect(page.getByLabel('镜头 3 标题', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '生成测试成片' })).toBeDisabled();
  await page.getByLabel('镜头 1 时长', { exact: true }).fill('2');
  await page.getByRole('button', { name: '保存分镜', exact: true }).click();
  await expect(page.getByRole('button', { name: '确认 V2', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '确认 V2', exact: true }).click();
  await expect(page.getByRole('button', { name: '生成测试成片' })).toBeEnabled();
  await page.getByRole('button', { name: '估算费用' }).click();
  await expect(page.getByRole('status')).toContainText('不调用付费 API');
  await page.getByRole('button', { name: '生成测试成片' }).click();
  const video = page.getByLabel('成片预览', { exact: true });
  await expect(video).toBeVisible({ timeout: 60000 });
  await expect.poll(() => video.evaluate(el => (el as HTMLVideoElement).readyState)).toBeGreaterThanOrEqual(1);
  const duration = await video.evaluate(el => (el as HTMLVideoElement).duration);
  expect(duration).toBeGreaterThan(3.8); expect(duration).toBeLessThan(4.3);
  await video.evaluate(async el => { const v = el as HTMLVideoElement; v.muted = true; await v.play(); });
  await expect.poll(() => video.evaluate(el => (el as HTMLVideoElement).currentTime)).toBeGreaterThan(0.1);
  await video.evaluate(el => (el as HTMLVideoElement).pause());
  await expect(page.getByRole('button', { name: '已生成成片', exact: true })).toBeDisabled();
  const log = page.locator('.event-log'); await log.locator('summary').click();
  await expect(log).toContainText('成片已完成，可预览或下载');
  await expect(log).toContainText('成片拼接已完成');
  await expect(log).toContainText('镜头视频已生成');
  await expect(log).not.toContainText('job.succeeded');
  await expect(log).not.toContainText('project.ready');
  await page.screenshot({ path: 'docs/screenshots/v1-studio.png', fullPage: true });
  await page.reload(); await page.getByRole('button', { name: /月光邮局/ }).first().click();
  await expect(page.getByLabel('成片预览', { exact: true })).toBeVisible();
  await page.locator('.event-log summary').click();
  await expect(page.locator('.event-log')).toContainText('成片已完成，可预览或下载');
  expect(errors).toEqual([]);
});

test('mobile layout remains within viewport and labels fixtures', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await page.goto('/');
  await expect(page.getByRole('button', { name: '开始规划分镜' })).toBeVisible();
  await expect(page.getByText('离线联调模式：', { exact: false })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: 'docs/screenshots/v1-mobile.png', fullPage: true });
});

test('real mode with no credentials explains setup and never silently simulates AI', async ({ page, request }) => {
  await page.goto('http://127.0.0.1:4322/');
  await expect(page.getByText('尚未配置 API 密钥。', { exact: false })).toBeVisible();
  await page.getByLabel('你的故事 / 创作要求').fill('一封寄给月亮的信');
  await expect(page.getByRole('button', { name: '开始规划分镜' })).toBeDisabled();
  await expect(page.getByText('离线联调模式：', { exact: false })).toHaveCount(0);
  const created = await request.post('http://127.0.0.1:4322/api/projects', { data: { story: '一封信' } });
  const p = await created.json(); const planned = await request.post(`http://127.0.0.1:4322/api/projects/${p.id}/plan`, { data: { revision: 0 } });
  expect(planned.status()).toBe(503);
});
