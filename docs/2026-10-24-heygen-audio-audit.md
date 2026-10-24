# HeyGen 声音核验与请求参数修正

## 实际产物证据

用户报告听不到声音时，项目仅生成了第 1 镜头「旧木箱里的信」，尚无 compose 成片。生成时分镜设为 ambient：没有台词、没有旁白，要求安静老屋、细微纸响与木箱声。归档的实际 Prompt 包含这些要求，没有要求完全静音；原片直接由云端下载，未经过 FFmpeg 合成或音量修改。

对本地原片只读解码：6.67 秒，AAC LC、32000 Hz、双声道；volumedetect 的平均音量 -68.3 dB、峰值 -35.7 dB。在 -50 dB / 0.2 秒阈值下，绝大多数时段被识别为静音。证据支持「音轨存在但声音非常轻」，不能称为完全无音轨，也不能归因为本地合成静音。FFmpeg 解码退出 0。报告保存在被忽略的 `data/acceptance/audio-audit.json`；没有修改原文件。

## 官方能力与接口

[HeyGen 官方模型页面](https://www.heygen.com/models/heygen-video)说明 heygen-video-1 可在同一生成中产生对话、环境声与音效，且只在要求时生成对白；[OpenRouter 模型页面](https://openrouter.ai/heygen/heygen-video-1)同样声明原生声音及首帧输入。

[OpenRouter POST /videos](https://openrouter.ai/docs/api/api-reference/video-generation/submit-a-video-generation-request) 明确：省略 generate_audio 时取端点 generate_audio 能力值，缺省 false。2026-10-24 实时公开目录中的 HeyGen 字段为 false，与原生声音描述存在语义不一致。目录快照保存在忽略目录 `data/acceptance/heygen-audio-model-catalog.json`。不能仅凭该字段断言 HeyGen 没有声音能力，也不能凭本次低响度产物确认路由层如何处理声音开关。

旧代码因 HeyGen 原生接口没有音频开关而省略 OpenRouter 的 generate_audio，混淆了两个接口契约。现针对已知 HeyGen 原生音频模型显式表达请求意图：ambient/speech 为 true；silent 或旧分镜无 audio 字段为 false。其他模型继续按目录校验后提交。静音镜头仍由最终合成策略强制静音，避免依赖模型完全遵循禁声 Prompt。

视频配置的 audioStrategy 版本同步更新，防止把旧参数生成的片段当成新请求结果；旧原片和首帧继续保留，生成仍需用户明确确认费用。首帧确认清单包含视频配置，因此更新后需要重新确认现有首帧清单，无需重生成首帧。已有云任务继续查询原 ID，不自动重复提交。

## 验收边界

定向 35 项测试通过；新增三种音频模式的请求断言和已有契约断言先失败后通过，类型检查与 18 项适配器回归通过。没有调用付费视频生成，没有自动修改用户声音设定，没有伪造旁白或添加背景音乐。

完整 `npm run verify` 通过：类型检查、21 个测试文件中的 168 项测试、生产构建，以及 12 项浏览器联调测试。独立代码复核未发现阻塞问题，并复跑 18 项适配器测试通过；复核覆盖缓存版本、旧任务恢复及其他模型的能力校验。

修正明确了 OpenRouter 请求参数，并不证明原片音量过轻由省略参数造成，也不代替供应商真实生成验收。当前仅检查是否存在音轨，尚无自动响度/语义质量判断。建议用户单独选择第 6 镜头的明确旁白试跑，再检查中文可懂度、音量与画面一致性；不要先全片重生成。
