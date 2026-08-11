# POC-04 Gateway 实现基线对照 Evidence

- 执行时间：2026-07-26
- 状态：**PASS_FOR_DECISION**
- 决策输出：[ADR-GATEWAY-BASELINE](../ADR-GATEWAY-BASELINE.md)
- 来源输出：[第三方源码来源与许可证清单](../第三方源码来源与许可证清单-v0.3.md)

## 对照对象

| 对象 | 冻结标识 | 许可证／来源 |
|---|---|---|
| 仟流 Node 薄 Gateway | 本目录三文件 SHA-256 | 独立实现，无第三方运行依赖 |
| TokenHub | Commit `1f4e7fe2bf25084f1a525e3ba2392be1e6bc49d2` | Apache-2.0 |
| Sub2API 本地快照 | Tree digest `626d7c0df33f78dfad1aa45df092372d6b8ebda5e3a1fc4f8581e500e5464ee0` | LGPL-3.0-or-later；缺 `.git`，Commit 不可证明 |

## 实际执行

### 1. 仟流 Node 候选

```text
18/18 tests PASS
100 concurrency: 100 success, 100 unique settlements
elapsed 9.579 ms; heap +305,520 B; RSS +2,818,048 B
```

### 2. TokenHub 窄测试

执行环境：官方 `golang:1.26-alpine`，参考目录只读挂载，CGO 开启。

```text
PASS TestProbeSuccessRecoversCoolingDownResource
PASS TestAdapterSessionBindingExpiresAfterOneHour
PASS TestChatCompletionStreamFailsOverBeforeFirstByte
PASS TestChatCompletionStreamDoesNotFailOverAfterCommitted
PASS TestClientCancellationIsNotRetryable
ok tokenhub/backend/internal/server 0.061s
```

### 3. Sub2API 窄测试

执行环境：官方 `golang:1.26-alpine`，参考目录只读挂载。

```text
PASS TestOpenAIGatewayService_ForwardCountTokensAsAnthropic_APIKeyUsesResponsesInputTokens
PASS TestIsolateOpenAISessionID
PASS TestCoderOpenAIWSClientDialer_ProxyClientCacheCapacity
PASS TestStreamWrittenGuard_MessagesPath_AbortFailoverOnSSEContentWritten
PASS TestStreamWrittenGuard_NoByteWritten_GuardNotTriggered
ok github.com/Wei-Shaw/sub2api/internal/service 0.022s
ok github.com/Wei-Shaw/sub2api/internal/handler 0.024s
```

## 同场景结论

| 场景 | Node 薄 Gateway | TokenHub | Sub2API |
|---|---|---|---|
| Key／模型／健康路由 | 可执行通过 | 有完整实现与测试资产 | 有成熟账号选择资产 |
| 双 Attempt 与唯一结算 | 可执行通过 | 有 Attempt／usage 证据结构，未跑同一夹具 | 有 failover／billing 资产，未跑同一夹具 |
| 提交前切换／提交后不拼接 | 可执行通过 | 两项窄测试通过 | 两项 stream guard 测试通过 |
| Affinity | HMAC 伪名、健康脱离通过 | TTL 过期测试通过 | Session 隔离测试通过 |
| count_tokens／WebSocket | 显式能力模型，未实现协议端点 | 当前对照未证明 | 两项相关窄测试通过 |
| 资源恢复 | 状态机覆盖异常脱离 | 冷却恢复测试通过 | 凭证生命周期代码面更广 |
| 经营调度与可证节省 | 可执行通过 | 非仟流业务模型 | 非仟流业务模型 |
| 100 并发 | 通过进程内候选压测 | 未跑同夹具 | 未跑同夹具 |
| 正文零留存 | canary 通过 | 默认审计能力与仟流零留存边界需隔离 | 需要逐路径审计 |
| 可维护性 | 领域最小、与 PRD 同名 | Go 全栈，迁移成本中 | 功能面很大，迁移成本高 |
| 许可证风险 | 无外部代码 | Apache-2.0 可控 | LGPL + Commit 缺失，直接复用风险高 |

## 未完成项

1. TokenHub／Sub2API 未运行同一套 100 并发夹具和 CPU／内存采样。
2. Sub2API 本地目录缺 Git 元数据，无法证明快照对应的上游 Commit。
3. 同夹具性能对照只在 ADR 复核条件触发时执行，不阻塞当前主路径。

## Planning 处置

本 PoC 的决策问题是“一期主路径是否直接复用外部底座”，不是证明三个项目功能／性能完全等价。当前结论是不直接复用 TokenHub／Sub2API 源码，因此：

- 仟流 Node 候选继续承担完整主夹具、100 并发和零正文留存验证；
- 两个外部项目以只读窄测试证明关键行为存在，不为落选路径追加迁移适配和全量压测欠账；
- 只有 ADR 复核触发且外部底座重新成为直接复用候选时，才补同一完整夹具、CPU／内存采样和许可证复核。

该处置已同步写回 TRD §17，属于有界范围裁定，不把“未跑”改写成“已跑”。

## 结论

对“一期选哪条主路径”已有足够证据：选择仟流独立 Node／TypeScript 实现，不直接合入两个参考项目源码。  
ADR 所需决策证据已经充分，POC-04 记为 **PASS_FOR_DECISION**；未跑项只作为 ADR 复核触发条件，不阻塞 Stage 01。
