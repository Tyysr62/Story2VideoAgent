# 阿里云 OSS 原生传输交付

已接入原生 `ali-oss` SDK 6.23.0，使用 V4 请求签名与 V4 下载 URL。`MEDIA_STORAGE_PROVIDER=oss` 显式选择阿里云；默认 `s3` 保留旧配置。两类凭据不互相借用。环境示例、README 与视频配置提示已覆盖两种存储。

仅在用户确认视频生成时，上传已确认首帧的校验后字节。上传带 private 对象 ACL、实际 MIME 和 SHA-256 metadata；对象键包含项目、资产编号和摘要。返回一小时有效、无需额外请求 headers 的 HTTPS GET 签名 URL，不将 URL 写入生产记录或导出。云端错误固定中文提示，不传出原始异常或凭据。Bucket 不会由应用自动创建、公开或清理。

本次支持标准公网地域 Endpoint，不支持 CNAME、内网、带 Bucket 的 Endpoint 或跨地域组合。北京填写 `oss-cn-beijing`、`https://oss-cn-beijing.aliyuncs.com`，Bucket 单独填写。用户提供的 Bucket 仅写本地环境文件，不写仓库样例。

代码检查依据：[官方 Node.js 初始化](https://www.alibabacloud.com/help/en/oss/initialization-10)、[V4 签名 URL](https://www.alibabacloud.com/help/en/oss/developer-reference/add-signatures-to-urls)、[PutObject 权限与参数](https://www.alibabacloud.com/help/en/oss/developer-reference/put-object)。RAM 访问限定实际 Bucket/前缀的 `oss:PutObject`、`oss:GetObject`；不会请求更改 Bucket ACL 或删除权限。

适配器/S3 测试 15 项通过，覆盖真实 SDK 上传请求与签名生成、私有 ACL、文件被篡改拦截、无凭据阻断、供应商显式选择、非法地域/地址/前缀及错误文本。HTTP 上传响应使用替身；没有联网写用户 Bucket。M2 相关 24 项测试与类型检查通过，之后补充的三项前缀边界回归也通过。独立只读代码审查通过，并另跑 15 项适配器测试。

当前本地 OSS AccessKey 尚未配置，不能以离线签名测试代替真实 Bucket 上传、权限及视频提供方下载验收。本轮不调用真实图片或视频生成。


全量 `npm run verify` 退出 0：21 个文件、165 项后端测试、12 项 Edge 浏览器测试，类型检查与构建通过。


本地主工作区快进合入、安装依赖及构建通过，27 项 OSS/S3/M2 回归通过。仅在被忽略的 `.env.local` 中选择 oss 并预填用户提供的非敏感参数，保留所有已有密钥；当前两项 OSS 凭据为空。确认无活动任务后重启，健康检查通过，实际工厂加载 AliyunOssStorage，前后端均显示存储尚未配置完成。

重启前后全部三个项目的 revision/status、分镜/角色库哈希、92 条生产记录和 16 个媒体文件 SHA-256 不变，包括用户在开发期间新生成的素材。验收快照保存在被忽略的 `data/acceptance/oss-*.json` / `.mjs` 中；提交差异通过本地密钥与本地文件排除检查。未进行真实上传、下载或付费模型调用；GitHub 未推送。


## 用户填写密钥后的真实 OSS 验收（2026-10-24）

用户完成本地凭据填写后，使用实际 AliyunOssStorage 及原生 SDK 上传一张 137 字节 PNG 到专用 connectivity-check 前缀。实际 PUT 成功，V4 签名 GET 成功且下载内容 SHA-256 与本地原图一致，去掉签名后的 HEAD 返回 403，确认测试对象匿名访问被拒绝。未将凭据、原始上游错误或带签名 URL 写入日志、生产记录或 Git；未调用图片/视频生成模型。

随后确认没有运行任务并重启服务，两个 V2 项目的 M2 接口均返回 transportConfigured=true。全部三个原项目的状态、版本、分镜/角色库哈希、92 条生产记录及 16 个媒体文件摘要保持不变。验收报告在被忽略的 `data/acceptance/oss-credentialed-smoke.json` 和 `oss-configured-*.json` 中。此项通过本机到 OSS 的上传及签名下载验收；HeyGen 提供方实际拉取与生成仍应由用户确认后单镜试跑验证。GitHub 未推送。
