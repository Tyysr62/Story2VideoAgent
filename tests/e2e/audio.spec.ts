import { test, expect } from '@playwright/test';

test('edits optional dialogue, narration and identity voice descriptions and preserves them after reload', async ({ page }) => {
  await page.goto('/'); await page.getByLabel('你的故事 / 创作要求').fill(`声音规划-${Date.now()}`); await page.getByRole('button', { name: '开始规划分镜' }).click();
  const shot = page.locator('.shot-card').first();
  await expect(shot.getByLabel('声音模式')).toHaveValue('silent');
  await shot.getByLabel('声音模式').selectOption('speech');
  await shot.getByRole('button', { name: '添加角色台词' }).click();
  await shot.getByLabel('台词 1 说话角色').selectOption('fox');
  await shot.getByLabel('台词 1 内容').fill('原来，你一直都记得。');
  await shot.getByLabel('台词 1 语气').fill('温柔、克制');
  await shot.getByLabel('旁白内容').fill('那封信，他保存了四十年。');
  await page.locator('.voice-profiles > summary').click();
  await page.getByLabel('旁白声音描述').fill('温暖的普通话女声');
  await page.getByLabel('小狐狸 声音描述').fill('轻柔的普通话少年声');
  await page.getByRole('button', { name: '保存分镜', exact: true }).click();
  await page.reload(); await page.getByRole('button', { name: /月光邮局/ }).first().click();
  await expect(shot.getByLabel('台词 1 内容')).toHaveValue('原来，你一直都记得。');
  await expect(shot.getByLabel('旁白内容')).toHaveValue('那封信，他保存了四十年。');
  await page.locator('.voice-profiles > summary').click();
  await expect(page.getByLabel('小狐狸 声音描述')).toHaveValue('轻柔的普通话少年声');
  await shot.getByLabel('声音模式').selectOption('ambient');
  await shot.getByLabel('环境声').fill('窗外细雨');
  await page.getByRole('button', { name: '保存分镜', exact: true }).click();
  await expect(shot.getByLabel('旁白内容')).toHaveCount(0);
  await expect(shot.getByLabel('环境声')).toHaveValue('窗外细雨');
  await page.setViewportSize({ width: 390, height: 844 }); expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});
