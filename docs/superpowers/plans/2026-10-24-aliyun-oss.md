# 阿里云 OSS 首帧传输适配

目标：完成用户已有北京 OSS Bucket 的本地配置，供云端视频模型读取已确认首帧。以原生 SDK 和 V4 签名接入；桶保持私有，签名 GET 有效一小时，凭据只保存在服务端本地。保留 S3 兼容存储，使用 MEDIA_STORAGE_PROVIDER 显式选择，默认 s3 兼容旧配置。

设计：FrameTransport 维持不变。新增 AliyunOssStorage、createFrameTransport；上传前共享 MIME、大小、SHA 校验与对象键构造。只支持与地域匹配的标准 OSS 公网 HTTPS Endpoint，本轮不支持内网、CNAME。环境字段使用 MEDIA_OSS_*，禁止静默借用其他供应商密钥。官方 SDK 固定 ali-oss 6.23.0、@types/ali-oss 6.23.4，启用 authorizationV4。

## 模块 A：原生适配与选择
- [x] 编写 OSS 适配测试，先验证入口缺失失败。
- [x] src/media/aliyun-oss.ts：SDK 上传使用 private 对象 ACL、MIME 与 SHA metadata；signatureUrlV4('GET',3600,undefined,key)，生成无需额外 HTTP headers 的下载地址。失败固定提示，不暴露凭据或签名链接。
- [x] src/media/storage-frame.ts：提取验证及对象键逻辑供 OSS/S3 共用。
- [x] src/media/frame-transport.ts：仅识别 s3/oss，未知值报错；旧配置默认 S3。
- [x] 运行 `npm test -- tests/aliyun-oss.test.ts tests/object-storage.test.ts` 和类型检查，通过后进入 B。

## 模块 B：应用配置与操作说明
- [x] src/server/main.ts 切换工厂；M2 和视频界面配置提示同时覆盖 OSS/S3。
- [x] .env.example 与 README 加入 OSS 字段、公网 endpoint、权限及私有签名说明。说明本地仍保留完整素材，OSS 仅用于云端传输。
- [x] 全量 verify、独立代码审查通过；本地主工作区合并、安装依赖及重新构建。
- [x] 仅写入用户已提供的地域、endpoint、bucket 与供应商选择，预留空凭据字段；保留现有密钥。检查原项目/素材不变后重启。
- [x] 汇报需要用户本地填写的密钥字段。未配置凭据时不声称真实联通，不调用付费生成；未获本次授权不推送 GitHub。

来源：[OSS Node.js 初始化](https://www.alibabacloud.com/help/en/oss/initialization-10)、[V4 签名 URL](https://www.alibabacloud.com/help/en/oss/developer-reference/add-signatures-to-urls)、[官方 SDK 6.23.0](https://github.com/ali-sdk/ali-oss)。
