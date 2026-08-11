# POC-01 北向客户端兼容 Evidence

- 执行时间：2026-07-26
- Owner：佳哥
- 状态：**PASS_FOR_STAGE01**

## 结论

Stage 01 需要冻结的是 Gateway 北向合同和一期协议边界，不是提前完成四种 GUI 客户端的正式发布验收。当前已通过真实 HTTP 进程验证：

- `GET /v1/models`；
- `POST /v1/chat/completions`（OpenAI Chat）；
- `POST /v1/messages`（Anthropic Messages）；
- Bearer 主体 Key；
- `x-request-id` 幂等；
- `x-session-id` 只保存 HMAC；
- 未启用端点显式返回 `422 capability_not_supported`。

隔离 Gateway 入口：[persistent-gateway](./persistent-gateway/)。

## 实际执行

```text
GET  /v1/models            200
POST /v1/chat/completions  200，usage=11/7/18，request_id=poc-http-process-smoke-01
POST /v1/messages          200，usage=11/7，request_id=poc-http-process-smoke-02
```

HTTP 返回体分别符合 OpenAI Chat 和 Anthropic Messages 的一期最小合同。持久化集成测试另覆盖无效 Key、幂等重放和能力显式拒绝。

## 客户端边界

本机已盘点 WorkBuddy 5.2.5、仟流 IDE 0.1.0、ZCode 3.5.2.3869、Claude Code 2.1.156。Windows 11 真机与四客户端 GUI E2E 属于 M6/M7 交付验收，不再作为 Stage 01 方案门禁；没有 Windows 客户端不阻塞服务器、Gateway、数据库、Web 和 Provider Adapter 开发。

## 未宣称完成

- 未宣称 WorkBuddy、Claude Code、ZCode 已在 Windows 11 完成 GUI E2E。
- 未启用 Responses、Embeddings、count_tokens 和 WebSocket；请求会显式拒绝。
- 流式、工具调用、取消和各客户端专有行为仍按 M6 自动化/真机矩阵验收。

## 判定

北向最小合同已足够支撑开发，**POC-01 通过 Stage 01**。Windows 真机差异保留为交付验收项，不是开工阻塞项。
