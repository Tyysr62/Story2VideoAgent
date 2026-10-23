import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { unzipSync, strFromU8 } from 'fflate';
import sharp from 'sharp';

test('project production library keeps revised prompts and downloads a real ZIP with media', async ({ page }) => {
  await page.goto('/'); await page.getByLabel('你的故事 / 创作要求').fill(`生产库-${Date.now()}`); await page.getByRole('button', { name: '开始规划分镜' }).click();
  const library = page.getByRole('region', { name: '项目生产库' }); await expect(library).toBeVisible();
  const shot = page.locator('.shot-card').first(); await shot.locator('summary').filter({ hasText: '生成提示词' }).click();
  await shot.getByRole('textbox', { name: '图像提示词', exact: true }).fill('新版图像 Prompt，保留旧版'); await page.getByRole('button', { name: '保存分镜', exact: true }).click();
  await library.getByLabel('生产内容类型').selectOption('prompt');
  await library.getByLabel('搜索生产内容').fill('新版图像 Prompt'); await expect(library.getByTestId('production-entry')).toHaveCount(1);
  await library.getByLabel('搜索生产内容').fill('狐狸与月光邮局'); await expect(library.getByTestId('production-entry').first()).toBeVisible();
  await page.getByRole('button', { name: '确认 V2', exact: true }).click(); await page.getByRole('button', { name: '生成测试成片' }).click();
  await expect(page.getByLabel('成片预览', { exact: true })).toBeVisible({ timeout: 60000 });
  await library.getByLabel('搜索生产内容').fill(''); await library.getByLabel('生产内容类型').selectOption('video'); await expect(library.locator('video').first()).toBeVisible();
  const downloadEvent = page.waitForEvent('download'); await library.getByRole('link', { name: '导出项目生产库 ZIP' }).click();
  const download = await downloadEvent; expect(download.suggestedFilename()).toContain('生产库.zip'); const archive = unzipSync(await readFile((await download.path())!));
  const manifest = JSON.parse(strFromU8(archive['manifest.json'])); expect(manifest.entries.some((e: any) => e.prompt === '新版图像 Prompt，保留旧版')).toBe(true);
  expect(manifest.entries.some((e: any) => e.prompt === '狐狸与月光邮局')).toBe(true); expect(Object.keys(archive).some(k => k.endsWith('.mp4'))).toBe(true);
});

test('M2 keyframes require role approval, retain candidates, and confirm the current contact sheet', async ({ page }) => {
  await page.goto('/'); await page.getByLabel('启用角色参考（V2）').check(); await page.getByLabel('你的故事 / 创作要求').fill(`首帧-${Date.now()}`); await page.getByRole('button', { name: '开始规划分镜' }).click();
  const panel = page.getByRole('region', { name: '分镜首帧与视频' }); await expect(panel).toBeVisible();
  await expect(panel.getByRole('button', { name: '估算首帧费用', exact: true })).toBeDisabled();
  const card = page.getByTestId('character-fox'); const png = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#81ab64' } }).png().toBuffer();
  await card.getByLabel('小狐狸 默认 上传参考图').setInputFiles({ name: 'role.png', mimeType: 'image/png', buffer: png });
  await page.getByRole('button', { name: '更新镜头引用到当前造型版本' }).click(); await page.getByRole('button', { name: '保存分镜', exact: true }).click(); await page.getByRole('button', { name: '确认角色定稿', exact: true }).click();
  await panel.getByRole('button', { name: '估算首帧费用', exact: true }).click(); await panel.getByLabel('我确认本次首帧生成费用').check(); await panel.getByRole('button', { name: '生成所选首帧', exact: true }).click();
  await expect(panel.getByAltText('镜头 1 首帧', { exact: true })).toBeVisible(); await expect(panel.getByText('当前可用', { exact: true })).toHaveCount(3);
  await panel.getByRole('button', { name: '确认整组首帧', exact: true }).click(); await expect(panel.getByText('整组首帧已确认', { exact: true })).toBeVisible();
  await page.reload(); await page.getByRole('button', { name: /月光邮局/ }).first().click(); await expect(panel.getByText('整组首帧已确认', { exact: true })).toBeVisible();
});
