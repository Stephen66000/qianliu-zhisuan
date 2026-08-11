# ADR-GATEWAY-BASELINE：一期 Gateway 实现基线

- 状态：**ACCEPTED（Stage 01 架构决策）**
- 日期：2026-07-26
- 决策 Owner：佳哥
- 产品约束 Owner：佳哥

## 决策

一期 Gateway 只保留一条主实现路径：

> **采用仟流独立 Node.js／TypeScript Gateway；以 PRD、TRD、公开协议和仟流测试夹具为实现权威。TokenHub／Sub2API 只作隔离行为对照，不直接复制或合入源码。**

## 原因

1. 仟流薄 Gateway 已用 18 个核心状态机测试、12 个 PostgreSQL／Redis／日志／Trace 集成测试证明路径成立，100 并发候选请求全部完成且结算唯一。
2. Node／TypeScript 能以最小模块直接表达 `Principal → Model Route → Candidate → Attempt → Usage → Ledger → Settlement`，与仟流领域模型一致。
3. TokenHub 的流式边界、Affinity 和资源恢复测试质量高，但其产品审计／存储边界与仟流当前 `METADATA_ONLY` 不完全一致。
4. Sub2API 在 count_tokens、WebSocket、账号生命周期和协议适配上资产丰富，但功能面远超一期；本地快照缺 Commit，且 LGPL-3.0-or-later 对直接复用提出额外义务。
5. 直接采用任一参考产品，会把其历史业务模型和许可证约束带入仟流；独立实现更容易保持产品边界与来源清晰。

## 一期模块边界

1. `northbound-contract`：Models、OpenAI Chat、Anthropic Messages；未启用能力显式返回 `capability_not_supported`。
2. `principal-auth`：Key 摘要、模型／IP／有效期／额度／并发限制与吊销。
3. `provider-adapter`：每厂商独立能力、鉴权、请求／响应、usage 和错误适配。
4. `route-engine`：硬过滤、静态优先级、多因子评分、Affinity 和有界切换。
5. `usage-ledger`：每个真实 Attempt 不可覆盖；每个请求一个幂等结算汇总。
6. `business-dispatch`：峰谷、倍率、等价资源、限流／拒绝／超额与反事实证据。
7. `supply-forecast`：多窗口速度、耗尽、恢复、覆盖和可信度。
8. `runtime-safety`：提交边界、取消、凭证隔离、数据库／Redis 失败策略和正文 canary。

## 禁止事项

- 不把 TokenHub／Sub2API 代码复制到产品目录后改名。
- 不在来源 Commit 不明时直接复用 Sub2API 文件。
- 不因参考项目支持更多协议就提前扩大一期范围。
- 不把 POC-03 的进程内性能数字当生产容量承诺。

## 代价

- 隔离 Spike 已实现 HTTP、PostgreSQL、Redis、JSONL 日志和 OpenTelemetry Trace；生产级 SSE、迁移、备份、监控、容量和三厂商 Adapter 仍需正式开发。
- Responses、Embeddings、count_tokens、WebSocket 是否一期启用，由对应客户端／Adapter 工作包冻结；未启用时显式拒绝。
- 参考项目已有能力只能转化为测试场景和设计约束，不能直接节省全部编码量。

## 复核触发条件

出现任一条件时重新评审本 ADR：

1. 真实 100 并发压测无法满足 Gateway P95 或资源目标；
2. Windows 客户端强依赖当前 Node 方案难以保真的 WebSocket／count_tokens 行为；
3. 三厂商流式或 OAuth 生命周期在 Node 方案中无法稳定实现；
4. 团队正式转为 Go 主栈并具备长期维护 Owner；
5. Sub2API 获得可证明 Commit，且法务确认目标复用方式与 LGPL 义务。

## Evidence

- [POC-03 计量闭环](./PoC/POC-03-计量闭环-Evidence.md)
- [POC-04 Gateway 基线对照](./PoC/POC-04-Gateway基线对照-Evidence.md)
- [第三方源码来源与许可证清单](./第三方源码来源与许可证清单-v0.3.md)

该 ADR 只冻结一期技术主路径。POC-01～04 的 Stage 01 结论与总体 `READY` 以[Stage 01 评审档](./仟流智算-Stage01方案准备评审-v0.3.md)为准。
