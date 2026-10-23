import { test, expect } from '@playwright/test';
import sharp from 'sharp';

test('a failed portrait request displays the reason beside the affected role without another POST', async ({ page }) => {
  await page.goto('/'); await expect(page.getByText('离线联调模式：', { exact: false })).toBeVisible(); await page.getByLabel('启用角色参考（V2）').check();
  await page.getByLabel('你的故事 / 创作要求').fill('候选图失败提示'); await page.getByRole('button', { name: '开始规划分镜' }).click();
  let submissions = 0;
  await page.route('**/looks/*/portrait', async route => { submissions++; await route.fulfill({ json: { status: 'failed', error: 'OpenRouter HTTP 400，诊断编号 fixture-error' } }); });
  const look = page.getByTestId('character-fox').getByTestId('look-默认');
  await look.locator('summary').filter({ hasText: 'AI 生成候选图' }).click(); await look.getByRole('button', { name: '查询生图费用' }).click(); await look.getByLabel('我确认本次生图费用').check();
  await look.getByRole('button', { name: '生成角色候选图', exact: true }).click();
  await expect(look.getByRole('alert')).toContainText('HTTP 400'); expect(submissions).toBe(1);
  // Another tab finishes an explicit generation. Polling must replace the local
  // failed response with the persisted success, without replaying this tab's POST.
  const projects = await (await page.request.get('/api/projects')).json();
  const id = projects.find((p: { story: string }) => p.story === '候选图失败提示').id;
  const state = await (await page.request.get(`/api/projects/${id}`)).json();
  const character = state.characterLibrary.characters.find((c: { id: string }) => c.id === 'fox');
  const generated = await page.request.post(`/api/projects/${id}/characters/fox/looks/${character.looks[0].id}/portrait`, { data: { revision: state.characterLibrary.revision, requestId: crypto.randomUUID(), acceptCost: true } });
  expect(generated.ok()).toBeTruthy(); expect((await generated.json()).status).toBe('succeeded');
  await expect(look.getByAltText('小狐狸 默认 主参考图')).toBeVisible();
  await expect(look.getByRole('alert')).toHaveCount(0); expect(submissions).toBe(1);
});

test('V2 role upload, manifest approval, stable @ binding, rename and invalidation survive reload', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('/'); await expect(page.getByText('离线联调模式：', { exact: false })).toBeVisible(); await page.getByLabel('启用角色参考（V2）').check();
  await page.getByLabel('你的故事 / 创作要求').fill('一只狐狸找到旧信，回忆与朋友重逢。');
  await page.getByRole('button', { name: '开始规划分镜' }).click();
  await expect(page.getByRole('heading', { name: '角色库', exact: true })).toBeVisible();
  const card = page.getByTestId('character-fox');
  const image = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#6789ab' } }).png().toBuffer();
  await card.getByLabel('小狐狸 默认 上传参考图', { exact: true }).setInputFiles({ name: 'fox.png', mimeType: 'image/png', buffer: image });
  await expect(card.getByAltText('小狐狸 默认 主参考图')).toBeVisible();
  await page.getByRole('button', { name: '更新镜头引用到当前造型版本', exact: true }).click();
  await page.getByRole('button', { name: '保存分镜', exact: true }).click();
  await page.getByRole('button', { name: '确认角色定稿', exact: true }).click();
  await expect(page.getByText('角色已定稿', { exact: true })).toBeVisible();
  await page.getByLabel('镜头 1 角色引用', { exact: true }).fill('@小');
  await page.getByRole('button', { name: '@小狐狸·默认', exact: true }).click();
  await page.getByRole('button', { name: '保存分镜', exact: true }).click();
  await card.getByLabel('角色名称', { exact: true }).fill('狐狸邮差');
  await card.getByRole('button', { name: '保存角色', exact: true }).click();
  await expect(page.getByText('角色已定稿', { exact: true })).toBeVisible();
  await expect(card.getByLabel('角色别名', { exact: true })).toHaveValue('小狐狸');
  await expect(page.getByText('@狐狸邮差·默认', { exact: true }).first()).toBeVisible();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: 'docs/screenshots/v2-character-library.png' });
  await card.getByLabel('造型描述', { exact: true }).fill('橙色皮毛，绿色围巾，圆眼睛，体型和脸型保持不变');
  await card.getByRole('button', { name: '保存造型', exact: true }).click();
  await expect(page.getByText('角色待定稿', { exact: true })).toBeVisible();
  await expect(page.getByText('参考图驱动首帧，再以已确认首帧生成视频', { exact: false })).toBeVisible();
  await page.reload(); await page.getByRole('button', { name: /月光邮局/ }).first().click();
  await expect(page.getByTestId('character-fox').getByLabel('角色名称', { exact: true })).toHaveValue('狐狸邮差');
  expect(errors).toEqual([]);
});

test('V2 generated portrait is explicitly a fixture in demo and supports adding an age look', async ({ page }) => {
  await page.goto('/'); await expect(page.getByText('离线联调模式：', { exact: false })).toBeVisible(); await page.getByLabel('启用角色参考（V2）').check();
  await page.getByLabel('你的故事 / 创作要求').fill('狐狸的青年与老年'); await page.getByRole('button', { name: '开始规划分镜' }).click();
  const card = page.getByTestId('character-fox');
  await card.locator('summary').filter({ hasText: '添加造型' }).click();
  await card.getByLabel('新造型名称').fill('老年'); await card.getByLabel('新造型描述').fill('灰白皮毛，蓝围巾，眼角皱纹');
  await card.getByRole('button', { name: '添加造型', exact: true }).click();
  const look = card.getByTestId('look-老年'); await look.locator('summary').filter({ hasText: 'AI 生成候选图' }).click(); await look.getByRole('button', { name: '查询生图费用', exact: true }).click();
  await look.getByLabel('我确认本次生图费用').check(); await look.getByRole('button', { name: '生成角色候选图', exact: true }).click();
  await expect(look.getByAltText('小狐狸 老年 主参考图')).toBeVisible();
  await expect(look.getByText('测试候选图 · 非真实 AI', { exact: true })).toBeVisible();
  const log = page.locator('.event-log'); await log.locator('summary').click();
  await expect(log).toContainText('分镜已保存（第 1 版，共 3 个镜头）');
  await expect(log).toContainText('角色候选图已生成：小狐狸 · 老年');
  await expect(log).not.toContainText('portrait.succeeded');
  await expect(log).not.toContainText('storyboard.updated');
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: 'test-results/v2-characters-mobile.png', fullPage: true });
});

test('polling a newer look version preserves an unsaved local edit until explicit reload', async ({ page, request }) => {
  const story = `并发编辑-${Date.now()}`;
  await page.goto('/'); await expect(page.getByText('离线联调模式：', { exact: false })).toBeVisible();
  await page.getByLabel('启用角色参考（V2）').check(); await page.getByLabel('你的故事 / 创作要求').fill(story); await page.getByRole('button', { name: '开始规划分镜' }).click();
  const card = page.getByTestId('character-fox'); await card.getByLabel('造型描述', { exact: true }).fill('未保存的绿色围巾');
  const projects = await (await request.get('/api/projects')).json(); const project = projects.find((p: any) => p.story === story);
  const detail = await (await request.get(`/api/projects/${project.id}`)).json(); const lib = detail.characterLibrary; const look = lib.characters[0].looks[0];
  await request.patch(`/api/projects/${project.id}/characters/fox/looks/${look.id}`, { data: { revision: lib.revision, description: '另一窗口保存的红围巾' } });
  await expect(card.getByText('造型已在其他窗口更新', { exact: false })).toBeVisible();
  await expect(card.getByLabel('造型描述', { exact: true })).toHaveValue('未保存的绿色围巾');
  await card.getByRole('button', { name: '载入当前造型版本' }).click(); await expect(card.getByLabel('造型描述', { exact: true })).toHaveValue('另一窗口保存的红围巾');
});

test('an in-flight role write disables switching projects until its response is applied', async ({ page }) => {
  await page.goto('/'); await expect(page.getByText('离线联调模式：', { exact: false })).toBeVisible(); await page.getByLabel('启用角色参考（V2）').check();
  await page.getByLabel('你的故事 / 创作要求').fill('保存时禁止切换'); await page.getByRole('button', { name: '开始规划分镜' }).click();
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/projects/*/characters/fox', async route => { await gate; await route.continue(); });
  const card = page.getByTestId('character-fox'); await card.getByLabel('角色名称', { exact: true }).fill('测试邮差'); await card.getByRole('button', { name: '保存角色', exact: true }).click();
  try { await expect(page.getByRole('button', { name: '＋ 新建故事', exact: true })).toBeDisabled(); } finally { release(); }
  await expect(page.getByRole('button', { name: '＋ 新建故事', exact: true })).toBeEnabled();
});


test('a new age look uses an explicit original reference with cost reconfirmation and preserves both assets', async ({ page }) => {
  const story = `参考图年龄编辑-${Date.now()}`; const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto('/'); await expect(page.getByText('离线联调模式：', { exact: false })).toBeVisible(); await page.getByLabel('启用角色参考（V2）').check();
  await page.getByLabel('你的故事 / 创作要求').fill(story); await page.getByRole('button', { name: '开始规划分镜' }).click();
  const card = page.getByTestId('character-fox'); const original = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#6789ab' } }).png().toBuffer();
  await card.getByLabel('小狐狸 默认 上传参考图', { exact: true }).setInputFiles({ name: 'original.png', mimeType: 'image/png', buffer: original });
  await expect(card.getByAltText('小狐狸 默认 主参考图')).toBeVisible();
  const originalUrl = await card.getByAltText('小狐狸 默认 主参考图').getAttribute('src');
  await card.locator('summary').filter({ hasText: '添加造型' }).click(); await card.getByLabel('新造型名称').fill('晚年'); await card.getByLabel('新造型描述').fill('白色皮毛，蓝色围巾，保留脸型'); await card.getByRole('button', { name: '添加造型', exact: true }).click();
  const look = card.getByTestId('look-晚年'); await look.locator('summary').filter({ hasText: 'AI 生成候选图' }).click();
  await look.getByLabel('生图方式', { exact: true }).selectOption('reference');
  await expect(look.getByLabel('参考图版本', { exact: true })).toContainText('默认 · V2');
  const preview = look.getByAltText('本次生图参考：小狐狸 默认 V2'); await expect(preview).toBeVisible(); await expect.poll(() => preview.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
  await look.getByLabel('本次修改要求', { exact: true }).fill('只变老，保留脸型和围巾');
  await look.getByRole('button', { name: '查询生图费用', exact: true }).click(); await look.getByLabel('我确认本次生图费用').check();
  await look.getByLabel('本次修改要求', { exact: true }).fill('白毛，保留五官和蓝围巾');
  await expect(look.getByRole('button', { name: '生成角色候选图', exact: true })).toHaveCount(0);
  await look.getByRole('button', { name: '查询生图费用', exact: true }).click(); await expect(look.getByLabel('我确认本次生图费用')).not.toBeChecked(); await look.getByLabel('我确认本次生图费用').check();
  await look.getByRole('button', { name: '生成角色候选图', exact: true }).click();
  await expect(look.getByAltText('小狐狸 晚年 主参考图')).toBeVisible(); await expect(card.getByAltText('小狐狸 默认 主参考图')).toHaveAttribute('src', originalUrl!);
  await expect(look.getByText('测试候选图 · 非真实 AI', { exact: true })).toBeVisible();
  const projects = await (await page.request.get('/api/projects')).json(); const id = projects.find((p: any) => p.story === story).id;
  const detail = await (await page.request.get(`/api/projects/${id}`)).json(); const snapshot = detail.portraitJobs.at(-1).inputSnapshot;
  expect(snapshot.editInstruction).toBe('白毛，保留五官和蓝围巾'); expect(snapshot.reference.assetId).toBe(originalUrl!.split('/').at(-1));
  await page.setViewportSize({ width: 390, height: 844 }); expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: 'test-results/qwen-reference-portrait-mobile.png', fullPage: true }); expect(errors).toEqual([]);
});
