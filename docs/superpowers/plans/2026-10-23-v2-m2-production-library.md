# M2 项目生产库与首帧链路实施计划

> 按用户既定要求在当前会话串行执行，每项验证通过后进入下一项；不用并行编码替代模块门槛。

**Goal:** 所有已保存生成内容进入项目生产库，可导出，并完成角色参考 → 首帧确认 → 图生视频。

**Architecture:** SQLite 生产记录保存不可变输入与版本、状态和输出；M2 执行器保存当前首帧选择与确认指纹。现有 V1、角色库与 Pi 保持兼容，通过统一归档入口记录产物。服务端使用用户自有 S3 兼容存储传输首帧。

**Tech Stack:** TypeScript、SQLite、React、Fastify、OpenRouter、S3 SDK、yazl 流式 ZIP、Vitest、Edge Playwright、FFmpeg。

## 1. 生产记录与历史回收

Files: `src/production/store.ts`, `src/storage/repository.ts`, `src/storage/characters.ts`, `src/characters/service.ts`, `src/workflow/workflow.ts`, `tests/production-store.test.ts`。

- [x] 编写不可变输入、项目隔离、重启读取、旧库迁移、重复回收去重、分镜改版历史、失败 Prompt 测试并观察失败。
- [x] 建立 production_entries 表及受控 create/update/get/list；分镜保存与生成前写输入；角色/V1产物纳入记录；旧元数据缺失显式标注。
- [x] `npm test -- tests/production-store.test.ts` 及全部既有单测通过；本地提交。

## 2. 项目生产库与导出

Files: `src/production/service.ts`, `src/server/production.ts`, `src/client/ProductionLibrary.tsx`, `tests/production-api.test.ts`, `tests/e2e/production.spec.ts`。

- [x] 写下载、ZIP 解包验证、跨项目拒绝、恶意路径与缺失文件测试，先观察失败。
- [x] 使用受控资产路径与 SHA-256 校验；ZIP snapshot 包含 JSON、Prompt 文本、媒体。前端分类筛选、预览、下载、完整导出。
- [x] 类型检查、导出 API 测试和浏览器测试通过；本地提交。

## 3. 首帧生产与确认

Files: `src/production/m2.ts`, `src/media/openrouter.ts`, `src/server/production.ts`, `src/client/Keyframes.tsx`, `tests/m2.test.ts`, `tests/openrouter.test.ts`。

- [x] 测试参考图片顺序、端点能力阻断、局部重做保留旧图、选择旧版本校验、确认失效与任务唯一性，观察失败。
- [x] 输入摘要绑定当前角色版本与图像摘要；Qwen 请求含 input_references。所有生成写生产库，当前首帧只存选择引用；在整组清单确认。
- [x] 首帧模块测试、全部累计单测与构建通过；本地提交。

## 4. 视频与最终联调

Files: `src/media/object-storage.ts`, `src/production/m2.ts`, `src/server/main.ts`, `.env.example`, `tests/m2.test.ts`, `tests/e2e/production.spec.ts`, `README.md`。

- [x] 测试 first_frame 请求、签名 URL 不进入导出、缺存储配置零付费、同一云 ID 恢复不重发、过期确认拒绝、未变镜头复用、合成顺序与可播放视频。
- [x] 配置 S3 endpoint/region/bucket/access key/secret；只上传用户提交任务中的已确认首帧。视频保存任务 ID、Prompt 与输出，支持单镜头和全量执行。
- [x] `npm run verify`、ZIP 真正解包核对、独立审查、真实服务只读验收。仅在明确发起时执行真实付费生成。
- [x] 更新导读／交付文档与测试结果，完成本地版本，询问是否推送 GitHub。
