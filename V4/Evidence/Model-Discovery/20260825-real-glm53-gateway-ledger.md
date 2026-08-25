# GLM-5.3 本机真实 Gateway 与账本 Evidence

时间：2026-08-25（Asia/Shanghai）

## 环境边界

- MacBook 隔离 worktree；
- 一次性 PG17 Testcontainer；
- 真实智谱 Coding Plan 上游；
- Mac Mini、生产数据库和生产配置均未访问；
- 本地临时主体、Key、Grant 和计价夹具随 Testcontainer 销毁。

## 真实 Gateway 请求

- 模型 Alias：`ql-glm-5.3`；
- 上游模型：`glm-5.3`；
- HTTP：`200`；
- Request ID：`ce9b837b-e3da-453a-9374-6530d8695933`；
- 稳定错误码：`null`；
- 北向 Usage：Input `52`、Output `256`、Total `308`。

## 账本

- `ai_request.status=SUCCEEDED`；
- Attempt：`1`；
- Usage Event：`1`；
- Ledger Line：`1`；
- Ledger Transaction：`1`；
- Input：`52`；
- Output：`256`；
- Cache：`0`；
- Reasoning：`251`；
- Usage Quality：`PROVIDER_REPORTED`；
- Resource Mode：`CODING_PLAN`；
- API Cost：`null`，Transaction 总 API Cost=`0.00000000`；
- Prompt canary 在 `ai_request`、`route_candidate`、`upstream_attempt`、`usage_event`、`ledger_line`、`ledger_transaction` 中命中：`0`。

## 测试计价边界

为通过现有 Gateway 最终授权门禁，本机一次性测试库使用 `rule_version=TEST_ONLY_NOT_VENDOR_FACT`、`multiplier=1` 的技术夹具。该倍率不是厂商事实，不得迁移、提交为默认值或部署到 Mac Mini。GLM-5.3 的正式套餐扣减规则仍保持未知，部署后在 Owner 确认规则前不得向正式主体授权。

## 结论

GLM-5.3 已通过真实 Gateway、鉴权、路由、上游调用、Token 解析、Reasoning Token、Attempt、Usage、Ledger Line、Ledger Transaction 与正文零留存验证。技术候选可以进入 Mac Mini 部署准备；正式模型授权仍受真实扣减规则/产品决策门禁约束。
