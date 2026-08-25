# W-MD-01～W-MD-06 本地验证 Evidence

日期：2026-08-25（Asia/Shanghai）

## 已实现的本地合同

- 官方来源：DeepSeek/Kimi API 保持正式 List Models；智谱 Coding Plan/智谱 API 走官方文档解析；Kimi Coding Plan 走 Kimi Code 官方模型页。
- 安全边界：HTTPS 厂商域名白名单、重定向拒绝、响应大小 512 KiB、模型数量上限、10 秒来源超时、Content-Type 约束、脚本/样式正文剔除、确定性模型 ID 语境解析。
- Evidence：来源 URL、解析器版本、ETag、Last-Modified、内容哈希、检查时间、字段级 Evidence、上下文/最大输出/思考策略/客户端变体。
- 降级：60 秒缓存和 singleflight；来源临时失败复用最近成功快照；首次失败使用明确过期的内置兜底；格式不识别/语境歧义拒绝部分结果。
- 状态保护：同步不新增 Key/Grant、不启用路由；确认只创建/复用统一模型和禁用路由；模型消失只写 `REMOVED/NOT_ADVERTISED`，不删除既有路由、授权或账单。
- 真实验证：`POST /provider-resources/:resourceId/models/:upstreamModel/validate` 要求 `confirm_quota_consumption: true`；持久化企业×资源×上游模型互斥、幂等结果和脱敏检查 Evidence；验证成功后才允许启用待配置 Model Route。
- GLM-5.3 请求约束：OpenAI Chat Completions、`glm-5.3`、文本、`reasoning_effort=max`，不发送 `thinking.type=disabled`；验证非流式、流式和最小 Function Calling；`glm-5.3[1m]` 只作为 Anthropic 客户端变体。

## 本地测试结果

| 范围 | 命令/结果 |
| --- | --- |
| Provider Adapter 单测/集成 | `@qianliu/provider-adapters test`：12 files / 135 tests passed |
| Provider Adapter lint | `@qianliu/provider-adapters lint` passed |
| Database typecheck/lint/build | passed |
| Database 串行目标回归 | 迁移框架、POOL-043、POOL20-047、POOL20-048：4 files / 9 tests passed |
| Control API 模型发现集成 | `pool027-provider-model-discovery.test.ts`：8 tests passed |
| Control API 账单/0057 迁移回滚回归 | `pool025-operating-bill.test.ts`：8 tests passed |
| Web Resources 页面 | `Resources.test.tsx`：17 tests passed |
| Web 全部测试 | 39 files / 197 tests passed |
| 全仓 typecheck/build | `pnpm typecheck`、`pnpm build` passed |
| 全仓 lint | provider-adapters/database/control-api/web passed |

全包 Database/Control API 并行测试本轮未作为验收证据：多个 PG17/Testcontainer 任务同时运行时出现既有测试的 30 秒迁移超时和并发断言波动，随后已停止；相关 W-MD 目标用例改为串行执行并通过。未据此修改业务代码。

## 真实 GLM-5.3 验证状态

2026-08-25 21:25～21:26 已在 MacBook 的一次性 PG17 Testcontainer 中完成真实厂商验证：非流式、流式和 Function Calling 均通过，验证前/后启用门禁、脱敏持久化、审计和零主体授权副作用均通过。详细结果见 `20260825-real-glm53-validation.md`。

本次仍没有访问 Mac Mini、生产数据库或生产配置，也没有创建或扩大任何主体 Key/Grant。真实验证通过不自动授权提交、推送、部署或生产主体开放。
