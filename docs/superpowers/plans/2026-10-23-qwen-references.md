# Qwen 2K 与角色参考编辑实施计划

**目标：** 新生成图片默认使用 2K；允许选用同角色已有图的不可变版本，结合修改要求生成新候选，保留完整生产记录。

**架构：** 扩展现有 PortraitBackend 和角色生成请求，不引入新服务。参考输入由服务器按项目、角色、造型版本解析，读取及校验后以图片 data URL 提交 Qwen；生产库只存资产编号、版本、摘要和文本，不存图片编码或本地绝对路径。沿用费用确认、CAS、未知状态阻止重复付费机制。

**技术栈：** TypeScript、Fastify、React、SQLite、Vitest、Playwright、OpenRouter /images。

## 模块 A：2K 默认配置与参考生图适配器
- [x] 先修改 tests/openrouter.test.ts 的默认分辨率断言为 2K，并增加方形参考编辑、端点不支持与参考内容被修改时禁止 POST 的测试，确认失败。
- [x] 修改 src/media/openrouter.ts：默认 2K，共用画幅相关端点检查；portrait 接受单张参考图，以 input_references 提交并固定已验证供应商，保留显式 1K 配置。
- [x] 更新 .env.example 并运行 `npm test -- tests/openrouter.test.ts tests/character-media.test.ts`，通过后进入 B。

## 模块 B：角色编辑与生产库溯源
- [x] 在 tests/character-media.test.ts、tests/character-api.test.ts 增加跨造型参考、重复请求变更输入、跨角色拒绝、损坏图片拒绝及导出溯源测试，先观察失败。
- [x] 修改 src/domain/characters.ts、src/storage/characters.ts、src/characters/service.ts、src/server/characters.ts。请求增加 reference:{lookId,lookVersionId} 与 editInstruction；只允许同角色已有图片版本。生成快照增加参考资产摘要及版本、修改要求；生产库添加依赖。异步检查后重新校验 CAS 和任务占用。
- [x] 运行角色、生产库及适配器测试和 `npm run check`，通过后进入 C。

## 模块 C：角色参考选择与预览
- [x] 在 tests/e2e/characters.spec.ts 增加上传原图→新建年龄造型→选择原图版本→输入修改要求→确认费用生成→保留历史及生产记录的浏览器测试，先确认入口缺失失败。
- [x] 修改 src/client/Characters.tsx、characters.css、App.tsx、src/server/main.ts：显式选择纯文字或参考编辑，显示来源预览，输入或参考变化撤销费用确认；显示配置分辨率；离线模式支持流程替身且明确标注。
- [x] 运行角色浏览器测试，通过后联调。

## 联调与交付
- [ ] `npm run verify` 全部通过，使用 requesting-code-review 技能审查，修复实际问题。
- [ ] 更新交付文档、操作说明；本地提交并合并到主工作区。
- [ ] 仅修改被忽略 .env.local 中的 IMAGE_RESOLUTION=2K，确认没有运行任务后重启服务；核验原项目、资产和文件摘要保留。
- [ ] 汇报结果并询问是否推送 GitHub；本轮不自动调用付费模型。
