# GLM-5.3 本机真实验证 Evidence

时间：2026-08-25 21:25～21:26（Asia/Shanghai）

## 环境边界

- 执行设备：MacBook；
- 数据库：一次性 PG17 Testcontainer；
- 应用：隔离 worktree 的 Control API；
- 上游：智谱 Coding Plan 官方 OpenAI Chat Completions；
- Mac Mini：未访问；
- 生产数据库／生产配置：未访问、未修改；
- Token：只从 macOS 钥匙串读入进程内存，未写文件、未写数据库明文、未写日志或 Evidence。

## 官方发现

- 来源：`OFFICIAL_DOCUMENTATION`；
- 解析器：`zhipu-docs-v1`；
- 核心页：`https://docs.bigmodel.cn/cn/coding-plan/latest-model`；
- 字段页：`https://docs.bigmodel.cn/cn/guide/models/text/glm-5.3.md`；
- 检查时间：`2026-08-25T13:25:54.081Z`；
- 内容哈希：`sha256:b242ce0394d03c09275ebcfb5525ffd1d29f827952969c580726b1334711d987`；
- 发现事实：`glm-5.3`、文本、1M 上下文、128K 最大输出、始终思考、`low/high/max`、默认 `max`、`glm-5.3[1m]` 仅为 Anthropic 客户端变体。

## 路由门禁

- 验证前启用：HTTP `409` / `model_route_validation_required`；
- 验证成功后启用：HTTP `200`，`enabled=true`；
- 主体 Key 新增：`0`；
- 主体 Grant 新增：`0`。

## 真实调用

- Request ID：`mdv-c54eb1c4-fee8-4556-8034-1a61063748ea`；
- Validation ID：`dfda68d6-31d2-442d-ad1a-7c3d32b3ec3a`；
- 最终状态：`SUCCEEDED`；
- 稳定错误码：`null`。

| 检查 | HTTP | 结果 | 耗时 | 首字节 | Input | Output | Reasoning |
| --- | ---: | --- | ---: | ---: | ---: | ---: | ---: |
| 非流式 | 200 | PASS | 1638 ms | 1637 ms | 19 | 16 | 13 |
| 流式 | 200 | PASS | 1863 ms | 717 ms | 19 | 69 | 64 |
| Function Calling | 200 | PASS | 5607 ms | 5605 ms | 171 | 35 | 19 |

## 持久化与审计

- `provider_model_validation.status=SUCCEEDED`；
- 持久化内容只有 Request ID、状态、耗时、首字节、Token 和稳定错误码；
- `provider_resource.models_sync=SUCCESS`；
- `provider_resource.models_confirm=SUCCESS`；
- `provider_resource.model_validate=SUCCESS`；
- 未保存 Prompt、响应正文或 Token 明文。

## 结论

真实 GLM-5.3 发现、确认、验证互斥、三类上游调用、脱敏 Evidence 和启用门禁通过。该结果只覆盖本机隔离候选，不自动覆盖 Mac Mini 部署、迁移、备份、健康检查或生产验收。
