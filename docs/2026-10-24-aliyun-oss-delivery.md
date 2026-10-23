# 阿里云 OSS 原生传输交付

已接入原生 `ali-oss` SDK 6.23.0，使用 V4 请求签名与 V4 下载 URL。`MEDIA_STORAGE_PROVIDER=oss` 显式选择阿里云；默认 `s3` 保留旧配置。两类凭据不互相借用。环境示例、README 与视频配置提示已覆盖两种存储。

仅在用户确认视频生成时，上传已确认首帧的校验后字节。上传带 private 对象 ACL、实际 MIME 和 SHA-256 metadata；对象键包含项目、资产编号和摘要。返回一小时有效、无需额外请求 headers 的 HTTPS GET 签名 URL，不将 URL 写入生产记录或导出。云端错误固定中文提示，不传出原始异常或凭据。Bucket 不会由应用自动创建、公开或清理。

本次支持标准公网地域 Endpoint，不支持 CNAME、内网、带 Bucket 的 Endpoint 或跨地域组合。北京填写 `oss-cn-beijing`、`https://oss-cn-beijing.aliyuncs.com`，Bucket 单独填写。用户提供的 Bucket 仅写本地环境文件，不写仓库样例。

代码检查依据：[官方 Node.js 初始化](https://www.alibabacloud.com/help/en/oss/initialization-10)、[V4 签名 URL](https://www.alibabacloud.com/help/en/oss/developer-reference/add-signatures-to-urls)、[PutObject 权限与参数](https://www.alibabacloud.com/help/en/oss/developer-reference/put-object)。RAM 访问限定实际 Bucket/前缀的 `oss:PutObject`、`oss:GetObject`；不会请求更改 Bucket ACL 或删除权限。

适配器/S3 测试 15 项通过，覆盖真实 SDK 上传请求与签名生成、私有 ACL、文件被篡改拦截、无凭据阻断、供应商显式选择、非法地域/地址/前缀及错误文本。HTTP 上传响应使用替身；没有联网写用户 Bucket。M2 相关 24 项测试与类型检查通过，之后补充的三项前缀边界回归也通过。独立只读代码审查通过，并另跑 15 项适配器测试。

当前本地 OSS AccessKey 尚未配置，不能以离线签名测试代替真实 Bucket 上传、权限及视频提供方下载验收。本轮不调用真实图片或视频生成。


全量 `npm run verify` 退出 0：21 个文件、165 项后端测试、12 项 Edge 浏览器测试，类型检查与构建通过。
