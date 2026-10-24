# Story2VideoAgent

把一个故事变成可编辑分镜，再通过云端 API 生成镜头，最后用 FFmpeg 拼成短片。基于 **Pi Coding Agent SDK** 的独立开源实现。

V1：故事 → Agent 自主分镜 → 人工编辑 / 版本确认 → API 生图与文生视频 → 持久化任务执行 → MP4 预览与下载。镜头数量由 AI 判断，允许 **1–20 个**。

V2 / M2：项目内角色库、不可变造型与 `@` 引用 → 角色参考约束首帧 → 整组首帧确认 → 图生视频 → FFmpeg 合成。新增**项目生产库**，保留图片、视频、Prompt 与分镜历史，支持预览、分类搜索、单项下载与完整 ZIP 导出。真实模式新项目默认 V2；演示模式默认 V1，可勾选 V2 体验角色与首帧流程。真实图生视频还需配置自有对象存储，见下方配置；没有存储配置会在提交视频费用前阻断。

M2.1：分镜增加**角色台词、画外旁白、环境声与静音模式**，全片统一角色声音描述；T2V / I2V 分别编译实际 Prompt，FFmpeg 保留原生音轨并补齐无声片段。只改台词或音色可复用首帧和未受影响的视频。独立 TTS、固定声线、口型修复与自动配乐尚未实现。

当前 M2.2：**分层声音同屏编辑、自然台词/表演规划**；首帧与视频各默认 **3 并发**，支持原生阿里云 OSS 和 Qwen 参考图生成。接下来进入 M3 检查与局部修复，详见 [更新路线图](docs/roadmap.md)。

![创作工作室](docs/screenshots/v1-home.png)

## 快速启动

```powershell
git clone https://github.com/Tyysr62/Story2VideoAgent.git
cd Story2VideoAgent
npm install
if (-not (Test-Path .env.local)) { Copy-Item .env.example .env.local }
# 在本地编辑 .env.local，填入 DEEPSEEK_API_KEY 和 OPENROUTER_API_KEY
npm run build
npm start
```

打开 [本地工作室](http://127.0.0.1:4310)。首次安装从网络下载依赖与 FFmpeg；无需安装或部署生成模型。仓库固定使用 Node 22.23.4，本地 `npm` 脚本会自动使用该运行时；不修改全局 Node。Pi 要求 Node ≥22.19，旧版本全局 Node 执行安装时可能提示 engine 警告。

`.env.local`、数据库与生成素材均已加入 Git 忽略。API 密钥只由服务端读取，不能填写到前端代码或提交到仓库。默认单机单用户，服务只监听 `127.0.0.1`。

### 默认云端模型

| 用途 | 默认模型 / 配置 |
|---|---|
| 导演规划 / 后续图片理解 | DeepSeek 官方直连 `deepseek-flash`，使用 `DEEPSEEK_API_KEY` |
| 镜头预览图 / 角色候选图 | `qwen/qwen-image-2.1-turbo`，默认 2K（`IMAGE_RESOLUTION` 可配置） |
| 文生视频 / 首帧视频 | `heygen/heygen-video-1`，480p，16:9，按分镜 Prompt 规划原生声音 |
| 最终拼接 | 本地 FFmpeg，1280×720 / 24fps，AAC 48kHz 双声道；按镜头计划保留声音或静音 |

DeepSeek 能力更正（2026-10-22）：当前官方 `deepseek-flash` 对应 V4.1 Flash 1017，支持原生文本 + 图片输入。Pi 的模型能力声明包含 `image`。[官方 Vision 文档](https://api-docs.deepseek.com/guides/vision/)、[官方更新日志](https://api-docs.deepseek.com/updates/)。按用户在 2026-10-23 确认的分工，DeepSeek 能力优先直连：分镜规划已使用官方端点，后续图片理解也沿用此配置。OpenRouter 负责图像/视频生成。M1 已支持角色参考图上传及生成；自动图片理解、视频抽帧视觉检查与质量反馈尚未交付。

价格与能力以 OpenRouter 实时目录为准。2026-10-23 的公开目录快照中，Qwen Turbo 1K / 2K 输出图像均约 $0.0184 / 张（本次查询的 Alibaba 端点参考输入图费用为 $0），HeyGen 文生视频 480p 约 $0.02 / 秒；20 个各 5 秒的镜头与 20 张预览图约 $2.368，**不含角色候选图、分镜模型、重试及其他输入费用**。参考图输入的视频采用不同计费项，M2 按参考输入另行估算。这只是目录估算，不是账单承诺。界面提供实时目录估算按钮；无法取得报价时显示未知，不伪造价格。

参考：[视频目录](https://openrouter.ai/api/v1/videos/models)、[默认图像端点](https://openrouter.ai/api/v1/images/models/qwen/qwen-image-2.1-turbo/endpoints)、[本次价格快照](docs/model-pricing-snapshot-2026-10-23.json)。生成前会校验视频模型支持的时长、分辨率与画幅，当前默认规划提示采用 HeyGen 支持的 5–15 秒 / 镜头。更换视频模型时还需核对 `main.ts` 的规划时长约束；更换图像模型时应同时核对 `IMAGE_RESOLUTION`，不能保证仅替换 ID 即兼容。

`DIRECTOR_PROVIDER=deepseek` 显式选择官方直连，即使同时存在 OpenRouter key，也只用 DeepSeek key 调用规划。供应商、端点、模型 ID 必须匹配；冲突配置会在本地报错。没有显式供应商和端点时，优先使用已配置的 DeepSeek key。需要用 OpenRouter 规划时，同时设置 `DIRECTOR_PROVIDER=openrouter`、`DIRECTOR_MODEL=deepseek/deepseek-v4.1-flash-1017`、`DIRECTOR_BASE_URL=https://openrouter.ai/api/v1`。

`OPENROUTER_API_KEY` 必须是普通推理密钥。管理 / Provisioning Key 可以通过认证和余额查询，但不能调用生成模型，不能用查询成功代替实际调用验收。详情见 [OpenRouter 官方管理密钥说明](https://openrouter.ai/blog/tutorials/team-spend-controls-setup/)。

### 不用密钥查看闭环

```powershell
npm run build
npm run demo
```

演示模式使用 **固定脚本分镜与 FFmpeg 色卡**，不调用模型，不产生 API 费用。页面和产物均标记模拟；它用于工程联调，不能证明生成质量。演示数据放在 `data/demo`，真实模式放在 `data/live`；如果设置了 `STORY_AGENT_DATA_DIR`，则优先使用指定目录。

在演示中给镜头添加声音后，视频会包含 440Hz 测试音，用于验证音轨链路；不是实际朗读台词或 AI 配音。

## 操作顺序

### V2 / M2：角色、首帧与视频

1. 保持勾选「启用角色参考（V2）」，输入故事并规划。AI 决定镜头数量，首次规划建立角色与默认造型文字草案。
2. 在角色库编辑身份描述、名称与别名；按需添加青年／老年／换装造型。历史别名会保留，不能通过清空字段破坏旧引用。
3. 为出镜造型上传主参考图，或展开 AI 候选图入口。可以「按文字生成新候选」，也可以「参考已有角色图修改」：选用同角色任一造型已有图片的历史版本，预览原图，填写本次修改要求，再查询费用、确认并生成。新年龄造型可引用青年图；上传图和已生成图均可用。参考图、修改要求或角色库变化后需重新确认费用。支持静态 PNG / JPEG / WebP，最多 10 MiB、4096×4096，按实际文件解码校验。演示图明确标注测试替身。
4. 图片或描述变化会建立新造型版本，旧图及版本保留；生成快照记录参考图版本、资产 SHA-256、修改要求与完整 Prompt，项目生产库 ZIP 同步包含这些记录。点击「更新镜头引用到当前造型版本」并保存分镜；也可以在单镜头输入 `@`，选择角色及造型。引用标签可展开查看绑定版本和原图。
5. 检查参考图与描述后「确认角色定稿」。外观、参考图或全局风格变化会使旧定稿失效；仅改名保留身份和引用。未保存修改不能直接定稿，另一窗口更新会显示冲突并保留本地文本。
6. 在「分镜首帧与视频」选择镜头、估算费用并确认后生成首帧。Qwen 使用实际参考图片输入；端点不支持参考数量、画幅或分辨率时阻断，不降级成纯文字生图。修改分镜、风格或相关角色版本后，会标出过期首帧；未变镜头可复用。
7. 逐镜审阅人物、场景和构图后，确认整组首帧。可选择单镜头试跑，或生成全部所选视频；新请求仍须估算并确认费用。图生视频单价与纯文生视频可能不同。已有云任务 ID 时继续轮询原任务，未知提交不自动重发。
8. 所有当前镜头视频齐备后自动按分镜顺序拼接成片。历史图像、片段、Prompt 和未选中的候选都保存在项目生产库，重新生成不覆盖旧版。M3 自动视觉检查与修复尚未交付。

批量首帧、视频默认各最多并行 3 条；图片和视频使用独立队列，多个项目共享并发上限。在 `.env.local` 设置 `IMAGE_CONCURRENCY` / `VIDEO_CONCURRENCY`（整数 1–8，设为 1 恢复串行），重启生效。并发只改变调度，不使已生成素材过期。V1 预览图和视频也分阶段并行，角色候选图共用图片额度；同项目角色版本编辑和首帧人工确认仍按依赖顺序执行。某项失败后暂停该批尚未开始的镜头，等待在途任务落库再解除项目忙状态，已有云任务 ID 继续查询，不自动重复收费提交。供应商内部排队或限流仍可能影响速度。

### 项目生产库与导出

每个故事有独立生产库，例如「一叠旧信」产生的内容均归入该项目。库内保存故事输入、导演实际请求 Prompt、每版分镜及图像／视频 Prompt、上传和生成角色图、首帧候选、视频片段、成片及失败／未知请求。生成记录固定输入、模型参数、依赖和内容摘要；当前使用哪一版由独立选择记录管理。

支持按图片／视频／Prompt 分类与搜索、下载原文件／记录 JSON／Prompt 文本，或一键导出项目生产库 ZIP。ZIP 包括 `manifest.json`、`records/`、`prompts/`、`images/`、`videos/`；异常未校验文件放入 `files/`。导出为时间点快照，清单会注明未完成、丢失或摘要不一致的文件。媒体按 SHA-256 校验，ZIP 流式输出。

旧项目启动时回收现存图片、视频、角色图、任务快照和当前分镜。旧版本若原先未保存 Prompt 或分镜，无法凭空恢复；回收内容明确标为历史，不用当前 Prompt 代替过去输入。环境文件、数据库、诊断日志及签名 URL 不进入导出包。生产库不提供自动清理／删除操作。

### M2.2：分层声音与自然台词

每个镜头使用「开启声音」总开关，环境声、动作音效、角色台词和旁白同时可编辑、可以共同生成。未填人声时只保留环境层；加上对白或旁白自动标记有人声，删除最后一条人声仍保留环境声和音效。未保存前临时关闭再开启可恢复本次声音草稿；保存静音后按静音保存。历史镜头未设置 audio 时继续静音。台词绑定角色 ID，并区分画内说话与画外声音；画内角色须出镜。

导演优先在合适的互动镜头安排人物短句、回应与追问，减少只靠旁白解释剧情的写法，仍保留无台词镜头和情绪留白。按人物关系和情绪自然使用语气词，避免机械堆砌。准确台词如“哎？这封你还留着啊……”，表达如“先轻笑、停半拍，再带笑轻声问”；纸张“沙沙”、敲门“咚咚”等写在音效，不让人物念出环境声音。表达指导中的呼吸、轻笑、叹息须表演而非口述；人声期间环境层继续，背景不能盖住对白，给动作和停顿留时间。

新规划采用新规则，已有已保存台词不自动改写。声音 Prompt 版本更新后，原视频仍保留在生产库，但会标为旧参数产物；首帧图片可复用，生成前需重新确认整组清单及费用。没有自动重生成。更改旧台词可直接编辑并保存；重新规划会生成整份新分镜，应先保留需要的版本。自动测试验证的是结构、请求和媒体链路，不能代替真实模型的语气、中文台词和混音质量试听。

展开「全片声音设定」编辑旁白及角色音色描述。原生音视频生成只能按描述引导音色，尚不保证跨镜头声线、中文发音和逐字台词准确性，请先单镜头试听。音色设定与外观分离，修改它不会使首帧过期；删除角色前需移除其镜头 / 台词引用，并清除声音设定、保存分镜。

图像 Prompt 只写静态首帧，视频 Prompt 只写可见动作、先后顺序与运镜；声音只在结构化声音区域填写，避免矛盾。编译器会分别处理 T2V 的主体/场景与 I2V 的首帧连续运动，并追加唯一的声音设计，默认不生成字幕和配乐。原始分镜、声音计划、音色描述、实际请求 Prompt 与参数均归档并随 ZIP 导出。

HeyGen 官方说明 Video 1 原生生成场景声音，但 2026-10-24 OpenRouter 目录的 generate_audio=false 与模型介绍存在歧义。调用的是 OpenRouter 包装接口，其省略开关时使用端点默认值，因此适配器对环境声/人声显式传 generate_audio=true，对静音或旧分镜缺省音频传 false；静音在最终成片中确定性执行。更换其他模型时，有声计划要求目录明确支持音频，否则收费提交前阻断。真实 HeyGen 中文台词、口型和该路由行为仍需单镜头实测；自动测试使用传输替身与真实 FFmpeg，不能替代模型质量验收。[HeyGen API](https://developers.heygen.com/reference/create-heygen-video) · [OpenRouter 视频接口](https://openrouter.ai/docs/api/api-reference/video-generation/submit-a-video-generation-request)

FFmpeg 保留输入中的声画相对时序，将无声片段补静音、短音轨补齐、超长音轨截到视频结束，再统一参数拼接。生产库中的云端原片保持原样，用户指定的静音策略应用于成片。若要求有声但返回没有音轨，原片保留并报错，不自动重新调用模型。旧版本未完成的云任务也不能因新版 Prompt 指纹变化而自动再提交费用。

### V2 视频素材传输：阿里云 OSS / S3 兼容对象存储

在 `.env.local` 本地配置，凭据不要发到聊天或 Git。阿里云 OSS 使用原生 SDK 与 V4 签名：

```dotenv
MEDIA_STORAGE_PROVIDER=oss
MEDIA_OSS_REGION=oss-cn-beijing
MEDIA_OSS_ENDPOINT=https://oss-cn-beijing.aliyuncs.com
MEDIA_OSS_BUCKET=your-private-bucket
MEDIA_OSS_ACCESS_KEY_ID=fill-locally
MEDIA_OSS_ACCESS_KEY_SECRET=fill-locally
MEDIA_OSS_PREFIX=story-agent
# 仅临时 STS 凭据需要；过期需在本地更新并重启。
MEDIA_OSS_STS_TOKEN=
```

OSS endpoint 填标准公网地域域名，不填带 Bucket 的域名、内网域名或 CNAME。密钥是阿里云 RAM AccessKey，与 DeepSeek/OpenRouter key 独立；本应用限定所用桶/前缀的 PutObject、GetObject 权限即可。对象上传设为 private，通过一小时有效的 V4 签名 GET 链接访问，无须公开桶。服务端会验证图片类型、大小和 SHA-256，不进行默认上传测试或自动提交视频。

[官方初始化说明](https://www.alibabacloud.com/help/en/oss/initialization-10)、[官方 V4 签名链接说明](https://www.alibabacloud.com/help/en/oss/developer-reference/add-signatures-to-urls)。

使用 AWS S3、Cloudflare R2 等 S3 兼容服务时配置：

```dotenv
MEDIA_STORAGE_PROVIDER=s3
MEDIA_S3_ENDPOINT=https://your-s3-compatible-endpoint
MEDIA_S3_REGION=us-east-1
MEDIA_S3_BUCKET=your-private-bucket
MEDIA_S3_ACCESS_KEY_ID=fill-locally
MEDIA_S3_SECRET_ACCESS_KEY=fill-locally
MEDIA_S3_PREFIX=story-agent
MEDIA_S3_FORCE_PATH_STYLE=false
```

AWS S3 可省略 endpoint，填写桶所在 region；Cloudflare R2 使用账户 S3 endpoint，region 为 `auto`。其他服务需启用 S3 兼容接口。凭据只需限定到所用桶／前缀的 PutObject、GetObject 权限。桶保持私有，服务仅在用户提交视频时上传已确认首帧，并生成 1 小时的签名 HTTPS GET URL 供视频提供方读取；不会自动上传至公共图床。端点必须可从公网访问。签名 URL 只在请求时使用，不进入生产记录或 ZIP；对象保留在用户桶中，可自行设置存储生命周期。

配置后重启服务。M2 不把本机 URL 发给云端，也不默认假设视频 API 接受 Base64 图片。模型生成、对象存储与网络费用分别计费；离线演示不使用云存储。

候选图失败会在对应造型旁显示原因。上游 HTTP 错误正文经脱敏后仅保存到本地数据目录的 `diagnostics/`，界面只显示固定错误说明与诊断编号；该目录不对前端开放、不纳入 Git。生成状态未知时仍阻止自动重提，避免重复付费。历史错误若未保存正文，无法靠这次更新补回具体原因。

角色图片由用户审阅，不自动保证同一身份在不同年龄阶段仍完全一致。首次 AI 规划提供默认造型，年龄阶段可手工补充；没有自动资产合并或跨项目市场。生成模型调用全部走 API，图片校验与 FFmpeg 在本地运行。

### V1：完整成片流程

1. 输入故事和风格要求，让 Agent 决定镜头数量并提交结构化草案。
2. 编辑标题、风格、镜头描述、运镜、时长和生成提示词，保存产生新版本。
3. 查询费用，确认当前版本。任何分镜修改都会使旧确认失效。
4. 点击「调用 API 生成」。预览图、文生视频分阶段受控并行生成，视频齐备后按分镜顺序合成。
5. 查看片段、进度、执行记录，播放或下载成片。

生图目前用于独立分镜预览，**没有作为视频首帧输入**；视频使用文本提示词。V1 支持新的声音设计与原生视频音轨；尚未实现图生视频、跨镜头身份验证、VLM 质量审查、自动局部修复、独立 TTS 或配乐。

## 设计与源码入口

```text
src/
  domain/storyboard.ts      1–20 镜头 Schema、项目/任务/产物类型
  domain/audio.ts           声音模式、台词/旁白契约与全片声音描述
  domain/characters.ts     身份、造型、不可变版本、@ 解析与稳定引用
  storage/repository.ts     SQLite、版本冲突检测、唯一任务键、事件
  storage/characters.ts    项目角色库、角色定稿清单和素材元数据
  storage/portrait-jobs.ts  独立角色生图任务及不可变请求快照
  characters/              实际图片解码、受控存储、候选图任务执行
  director/pi-director.ts   真正的 Pi AgentSession 与结构化分镜工具
  config/providers.ts      官方端点、供应商与凭据的匹配，防止跨供应商错发
  media/openrouter.ts      云端目录、报价、生图、异步视频、结果下载
  media/video-prompt.ts    有版本号的 T2V / I2V 与声音 Prompt 编译器
  media/object-storage.ts  自有私有桶上传与限时首帧传输
  media/ffmpeg.ts           成片拼接与明确隔离的离线测试素材
  production/              生产记录、历史回收、流式 ZIP、M2 首帧与视频执行
  workflow/workflow.ts      确认门禁、去重、持久化执行、重启恢复
  server/                  Fastify HTTP API / 启动入口
  client/                  React 创作界面
tests/                     单元、契约、真实 HTTP / FFmpeg 联调、浏览器测试
```

Pi 只获得 `propose_storyboard` 工具，不获得 shell、文件读写或项目扩展。它负责创作决策；付费任务由确定性的执行器负责。SQLite 是业务状态来源，Pi 会话是单次内存会话，不替代业务数据库。

V1 唯一任务键为「项目 + 分镜版本 + 任务类型 + 镜头 ID」；V2 另以规范化输入、模型配置、依赖与首帧摘要识别可复用片段。重复点击不会自动重做有效产物。云端视频任务 ID 提交后立即持久化；重试或重启后优先查询已有 ID。提交超时 / 服务器异常导致结果不明时标记 `unknown`，阻止自动重复提交。需要先在 OpenRouter 核实；**当前尚无手工核销 / 绑定未知任务的界面，不能直接点重试解决 `unknown`**。

V1 已明确失败且没有云端任务 ID 的任务可人工重试，最多 3 次；V2 每次由用户确认费用后建立新生产记录，未知输入禁止重提。已有视频 ID 时继续查询原任务。图片已返回后发生本地保存故障、视频 ID 无法落库等情况都会保守标记 `unknown`；输出路径预先持久化，启动时找回已写出但未正式保存的内容。重新规划／改版会按实际依赖使确认或产物过期，M2 未变镜头可复用。规划和生成互斥，生成期间禁用编辑；未保存角色／造型／分镜草案也会锁住 M2 费用操作。独立镜头受控并行，项目审批和成片合成遵守依赖顺序；单实例运行，请勿启动多个进程共享同一数据目录。

当前约束：图像返回体最多约 40MB Base64，视频片段下载最多 256MB，单次 FFmpeg 默认 120 秒。媒体下载对外部存储域名有白名单，供应商变更存储域时可能需要适配。任务失败原因会脱敏，不回显供应商响应正文或密钥。完整本机备份应保存 SQLite 与整个项目数据目录（含 `artifacts`、`characters`、`production`）；生产库 ZIP 是可移植内容包，不等同于一键恢复的数据库备份。

## 测试与验收

```powershell
npm run check
npm test
npm run build
# Windows 默认使用已安装的 Edge。没有 Edge 时先安装：
npx playwright install msedge
npm run test:e2e
# 或一次执行全部检查：
npm run verify
```

本机也可使用已安装的 Edge：

```powershell
$env:PLAYWRIGHT_CHANNEL = 'msedge'
npm run test:e2e
```

浏览器测试启动 4321（演示）与 4322（无凭据真实模式）端口，测试数据位于 `data/e2e*`。执行顺序、实际测试结果、联调修复和验收边界见 [模块交付记录](docs/delivery.md)。

成片是 H.264 MP4，预览需要支持 H.264 的浏览器。Playwright 精简 Chromium 在本机实测不含该解码器，因此 Windows 默认以完整 Edge 做真实播放验收；Linux / macOS 和 CI 默认完整 Chrome，先执行 `npx playwright install --with-deps chrome`。可用 `PLAYWRIGHT_CHANNEL` 显式切换到其他支持该编码的浏览器。不能把缺少解码器导致的失败通过跳过播放断言掩盖。

自动化测试不消耗真实 API 额度：真实 Pi HTTP 编解码、SQLite、FFmpeg 与浏览器运行；云端响应由测试服务 / Fetch 替身提供。**M2.2 最近完整验证：183 项自动化测试（23 文件）、15 项 Edge 浏览器测试、类型检查与构建通过**，覆盖混合声音编辑/导出、草稿隔离、并行生成、任务恢复、真实音轨采样和首帧复用。本地阿里云 OSS 上传和签名下载已核验；真实角色一致性、中文发音与声音自然度仍须用实际产物评估。验收边界见 [M2.2 记录](docs/2026-10-24-layered-natural-audio-acceptance.md)、[并行生产记录](docs/2026-10-24-parallel-media-acceptance.md)。早期结果保留在 [M2](docs/v2-m2-delivery.md) 与 [M2.1](docs/m2-1-delivery.md) 交付记录中。

## 项目来源与许可

本项目是新建的独立实现，作为对故事成片 Agent 的公开工程重建；不包含历史雇主源码、数据、资产或线上指标。Pi 通过 npm SDK 引入，请保留其 MIT 许可及依赖各自的许可说明。

ERP-AGENT 仅用于理解审批、执行与状态持久化等设计，没有复制其源码或素材。当前实现与简历中的历史项目是不同交付物，公开效果应以此仓库可复现实验为准。

本仓库自有源码采用 [MIT](LICENSE)。FFmpeg 二进制为 `ffmpeg-static` 下载的外部依赖，不纳入源码仓库；再分发二进制前请检查其构建与 LGPL/GPL 许可要求。云端模型及输出还受对应服务条款约束。
