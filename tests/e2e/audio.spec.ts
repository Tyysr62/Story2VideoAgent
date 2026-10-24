import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { unzipSync, strFromU8 } from 'fflate';
import { inspectMedia } from '../../src/media/ffmpeg.js';

test('layers character speech and ambience, restores unsaved mute and preserves the mix through playback and export', async ({ page }) => {
  await page.goto('/'); await page.getByLabel('你的故事 / 创作要求').fill(`声音规划-${Date.now()}`); await page.getByRole('button', { name: '开始规划分镜' }).click();
  const shot = page.locator('.shot-card').first();
  await expect(shot.getByLabel('开启声音')).not.toBeChecked();
  await shot.getByLabel('开启声音').check();
  await expect(shot.getByLabel('旁白内容')).toBeVisible();
  await shot.getByLabel('环境声').fill('窗外细雨');
  await shot.getByLabel('音效', { exact: true }).fill('沙沙，翻信声');
  await shot.getByLabel('音效', { exact: true }).press('End'); await shot.getByLabel('音效', { exact: true }).press('Enter'); await shot.getByLabel('音效', { exact: true }).pressSequentially('脚步嗒嗒');
  await shot.getByRole('button', { name: '添加角色台词' }).click();
  await shot.getByLabel('台词 1 说话角色').selectOption('fox');
  await shot.getByLabel('台词 1 内容').fill('哎？这封你还留着啊……');
  await shot.getByLabel('台词 1 语气').fill('先轻笑，停半拍，再带笑轻声问');
  await shot.getByLabel('旁白内容').fill('那封信，他保存了四十年。');
  await shot.getByLabel('开启声音').uncheck(); await expect(shot.getByLabel('环境声')).toHaveCount(0);
  await shot.getByLabel('开启声音').check();
  await expect(shot.getByLabel('台词 1 内容')).toHaveValue('哎？这封你还留着啊……');
  await expect(shot.getByLabel('环境声')).toHaveValue('窗外细雨'); await expect(shot.getByLabel('音效', { exact: true })).toHaveValue('沙沙，翻信声\n脚步嗒嗒');
  await page.locator('.voice-profiles > summary').click();
  await page.getByLabel('旁白声音描述').fill('温暖的普通话女声');
  await page.getByLabel('小狐狸 声音描述').fill('轻柔的普通话少年声');
  await page.getByRole('button', { name: '保存分镜', exact: true }).click();
  await page.reload(); await page.getByRole('button', { name: /月光邮局/ }).first().click();
  await expect(shot.getByLabel('台词 1 内容')).toHaveValue('哎？这封你还留着啊……');
  await expect(shot.getByLabel('旁白内容')).toHaveValue('那封信，他保存了四十年。');
  await expect(shot.getByLabel('环境声')).toHaveValue('窗外细雨'); await expect(shot.getByLabel('音效', { exact: true })).toHaveValue('沙沙，翻信声\n脚步嗒嗒');
  await page.locator('.voice-profiles > summary').click();
  await expect(page.getByLabel('小狐狸 声音描述')).toHaveValue('轻柔的普通话少年声');
  await shot.locator('.audio-editor').screenshot({ path: 'docs/screenshots/v2-m2-2-layered-audio.png' });
  await page.getByRole('button', { name: '清除小狐狸声音设定', exact: true }).click();
  await expect(page.getByLabel('小狐狸 声音描述')).toHaveValue('');
  await shot.getByRole('button', { name: '删除台词 1' }).click(); await shot.getByLabel('旁白内容').fill('');
  await page.getByRole('button', { name: '保存分镜', exact: true }).click();
  await expect(shot.getByLabel('旁白内容')).toHaveValue('');
  await expect(shot.getByLabel('环境声')).toHaveValue('窗外细雨');
  await expect(shot.getByLabel('音效', { exact: true })).toHaveValue('沙沙，翻信声\n脚步嗒嗒');
  await shot.getByRole('button', { name: '添加角色台词' }).click();
  await shot.getByLabel('台词 1 内容').fill('嗯，哪舍得扔。'); await shot.getByLabel('台词 1 语气').fill('轻轻叹息，句尾放轻');
  await page.getByRole('button', { name: '保存分镜', exact: true }).click();
  await page.getByRole('button', { name: /^确认 V\d+$/ }).click(); await page.getByRole('button', { name: '生成测试成片' }).click();
  await expect(page.getByLabel('成片预览', { exact: true })).toBeVisible({ timeout: 60000 });
  const videoDownload = page.waitForEvent('download'); await page.getByRole('link', { name: '下载 MP4' }).click();
  expect((await inspectMedia((await (await videoDownload).path())!)).hasAudio).toBe(true);
  const zipDownload = page.waitForEvent('download'); await page.getByRole('link', { name: '导出项目生产库 ZIP' }).click();
  const archive = unzipSync(await readFile((await (await zipDownload).path())!)); const manifest = JSON.parse(strFromU8(archive['manifest.json']));
  expect(manifest.entries.some((e: any) => e.kind === 'video' && e.prompt?.includes('窗外细雨') && e.prompt?.includes('翻信声') && e.prompt?.includes('嗯，哪舍得扔。') && e.prompt?.includes('声音分层'))).toBe(true);
  expect(manifest.entries.some((e: any) => e.kind === 'storyboard' && e.content?.shots[0].audio?.dialogue[0]?.text === '哎？这封你还留着啊……')).toBe(true);
  await page.setViewportSize({ width: 390, height: 844 }); expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

test('saving silence drops the temporary sound draft instead of restoring it into the next revision', async ({ page }) => {
  await page.goto('/'); await page.getByLabel('你的故事 / 创作要求').fill(`静音版本隔离-${Date.now()}`); await page.getByRole('button', { name: '开始规划分镜' }).click();
  const shot = page.locator('.shot-card').first();
  await shot.getByLabel('开启声音').check(); await shot.getByLabel('环境声').fill('只属于未保存版本的雨声');
  await shot.getByLabel('开启声音').uncheck();
  const save = page.getByRole('button', { name: '保存分镜', exact: true }); await save.click(); await expect(save).toBeDisabled();
  await expect(shot.getByLabel('开启声音')).not.toBeChecked(); await shot.getByLabel('开启声音').check();
  await expect(shot.getByLabel('环境声')).toHaveValue(''); await expect(shot.getByLabel('音效', { exact: true })).toHaveValue('');
  await expect(shot.getByLabel('旁白内容')).toHaveValue('');
});

test('reloading the same saved revision discards the temporary muted draft', async ({ page }) => {
  await page.goto('/'); await page.getByLabel('你的故事 / 创作要求').fill(`声音重载隔离-${Date.now()}`); await page.getByRole('button', { name: '开始规划分镜' }).click();
  const shot = page.locator('.shot-card').first();
  await shot.getByLabel('开启声音').check(); await shot.getByLabel('环境声').fill('应该被明确重载丢弃的声音');
  await shot.getByLabel('开启声音').uncheck();
  await page.locator('.project-list button.selected').click();
  await shot.getByLabel('开启声音').check(); await expect(shot.getByLabel('环境声')).toHaveValue('');
});

test('background revision polling preserves an unsaved temporary muted draft', async ({ page, request }) => {
  const story = `声音轮询隔离-${Date.now()}`;
  await page.goto('/'); await page.getByLabel('你的故事 / 创作要求').fill(story); await page.getByRole('button', { name: '开始规划分镜' }).click();
  const shot = page.locator('.shot-card').first();
  await shot.getByLabel('开启声音').check(); await shot.getByLabel('环境声').fill('本地还没保存的雨声'); await shot.getByLabel('开启声音').uncheck();
  const project = (await (await request.get('/api/projects')).json()).find((p: any) => p.story === story);
  const detail = await (await request.get(`/api/projects/${project.id}`)).json();
  const response = await request.put(`/api/projects/${project.id}/storyboard`, { data: { revision: project.revision, storyboard: detail.project.storyboard } }); expect(response.ok()).toBe(true);
  await expect(page.locator('.project-heading .muted')).toContainText(`V${project.revision + 1}`);
  await shot.getByLabel('开启声音').check(); await expect(shot.getByLabel('环境声')).toHaveValue('本地还没保存的雨声');
});
