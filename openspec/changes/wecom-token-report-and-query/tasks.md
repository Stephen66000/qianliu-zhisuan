# Implementation Tasks: 企业微信自建应用 Token 每日长图日报与实时交互查用量

## Phase 1: 加解密与企微回调基础设施

- [x] 1.1 在 `packages/provider-adapters/src/wecom-crypto.ts` 中实现企微加解密工具函数：
  - [x] 1.1.1 实现 `verifyWecomSignature(token, timestamp, nonce, encrypt, signature)`
  - [x] 1.1.2 实现 `decryptWecomMessage(encodingAesKey, encrypt)`（AES-256-CBC、去除 PKCS#7 及长度头）
  - [x] 1.1.3 实现 `encryptWecomMessage(token, encodingAesKey, replyXml, timestamp, nonce)`
  - [x] 1.1.4 编写 `wecom-crypto.test.ts` 单元测试，覆盖微信官方加密用例
- [x] 1.2 在 `apps/control-api/src/wecom/callback-routes.ts` 中实现企微回调端点：
  - [x] 1.2.1 `GET /api/wecom/callback`：URL 签名验证并解密 `echostr` 返回
  - [x] 1.2.2 `POST /api/wecom/callback`：接收 XML 消息、验签、解密并提取 `FromUserName` 与 `Content`
  - [x] 1.2.3 在 `apps/control-api/src/server.ts` 注册 XML content-parser 与回调路由

## Phase 2: 交互式问答与用量查询

- [x] 2.1 在 `apps/control-api/src/wecom/intent-parser.ts` 中实现自然语言意图与时间解析：
  - [x] 2.1.1 支持解析“今天”、“昨天”、“上一周”、“本周”、“本月”、“上月”
  - [x] 2.1.2 支持解析“全员/团队”修饰词与管理员鉴权
  - [x] 2.1.3 编写 `intent-parser.test.ts` 单元测试，覆盖各种提问语料
- [x] 2.2 在 `apps/control-api/src/wecom/message-handler.ts` 中实现问答业务逻辑：
  - [x] 2.2.1 根据 `FromUserName` 匹配 `person_external_identity` -> `principal`
  - [x] 2.2.2 未关联人员时返回友好指引文案
  - [x] 2.2.3 依据解析时间窗口调用 `UsageOverviewRepository` 查询用量数据
  - [x] 2.2.4 组装格式友好的排版图文文本回复（包含 Token 总量、输入/输出、请求次数、常用模型）
  - [x] 2.2.5 编写集成测试 `callback-routes.test.ts` 验证问答闭环

## Phase 3: 每日 Token 看板图片渲染与企微图片推送

- [x] 3.1 引入图片渲染依赖并扩展企微客户端：
  - [x] 3.1.1 安装 `@resvg/resvg-js`
  - [x] 3.1.2 扩展 `apps/worker/src/runtime-assurance/wecom-client.ts`：增加 `uploadMedia`（上传图片到企微素材库获取 `media_id`）与 `sendImageMessage`
- [x] 3.2 在 `apps/worker/src/reporting/daily-token-report.ts` 中实现长图生成与推送：
  - [x] 3.2.1 实现昨日全员用量统计（总 Token、总费用、总调用、活跃人数、Top 10 排行、模型份额）
  - [x] 3.2.2 实现现代深色科技风格 SVG 模板生成器
  - [x] 3.2.3 将 SVG 模板通过 `@resvg/resvg-js` 转为高质量 PNG 图片 Buffer
  - [x] 3.2.4 编写 `daily-token-report.test.ts` 验证图片生成尺寸与合法性

## Phase 4: 调度集成、CLI 与端到端验收

- [x] 4.1 在 `apps/worker/src/main.ts` 中增加调试命令与定时调度：
  - [x] 4.1.1 增加 CLI 命令 `worker daily-token-report --enterprise <id> [--date <YYYY-MM-DD>] [--recipients <user1,user2>]`
  - [x] 4.1.2 在 `runScheduledOperationalTasks` 中接入每日 09:00 定时执行
- [x] 4.2 全流程门禁与验收测试：
  - [x] 4.2.1 运行 `pnpm typecheck`、`pnpm test`
  - [x] 4.2.2 运行 `pnpm quality:architecture` 确保符合架构规范无循环依赖
  - [x] 4.2.3 模拟与集成验收企微回调问答与图片推送
