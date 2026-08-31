# ZCode 自定义 Provider 子 Agent 问题调研

- 收集时间：2026-08-08 12:12 +08:00
- 客户端：ZCode 3.7.3（build 3.7.3.4573）
- 调研目的：确认 ZCode 是否禁止自定义 Provider 使用 `Agent`／子 Agent，并定位仟流智算通道的实际失败原因。

## 结论

**ZCode 3.7.3 没有禁止自定义 Provider 使用子 Agent。**

本机日志已经证明，仟流自定义 Anthropic Provider：

1. 主 Agent 成功返回 `Agent` 工具调用；
2. ZCode 成功创建 `Explore` 子 Agent；
3. 子 Agent 继续通过 `https://gw.qianliuai.com` 请求 `qianliu-zhipu-glm-5-2`；
4. 最终失败不是工具缺失，而是当时模型上下文仍为 `256`，触发 `compact_rapid_refill_breaker`，错误再向上传导为 `Agent` 工具调用失败。

因此，handoff 中“ZCode 只对内置 Provider 开放 Agent 工具”的判断不成立。子 Agent 问题与 autocompact 是同一个配置根因，不是第五个独立问题。

## 本机证据

日志文件：`~/.zcode/cli/log/zcode-2026-08-08.jsonl`

关键事件链（UTC）：

| 时间 | 事件 | 关键内容 |
| --- | --- | --- |
| 00:42:00.625 | `model.request.completed` | 自定义 Provider 主请求成功，`finishReason=tool-calls` |
| 00:42:00.874 | `tool.call.started` | `toolName=Agent` |
| 00:42:00.903 | `subagent.spawned` | `agentType=Explore` |
| 00:42:06.850 | `model.request.completed` | `querySource=subagent`，`baseURL=https://gw.qianliuai.com`，请求成功 |
| 00:45:20.267 | `compact.rapid_refill_breaker` | `contextWindow=256`，连续快速回填 3 次 |
| 00:45:20.275 | `tool.call.failed` | `toolName=Agent`，错误为 `MODEL_CONTEXT_EXCEEDED` |

当前 `~/.zcode/v2/config.json` 已把该模型改为：

```json
"limit": { "context": 1000000 }
```

配置文件修改时间为 2026-08-08 12:10:54 +08:00，晚于上述失败测试。因此上述失败会话实际仍使用旧的 `256` 配置，不能用于判断修复后的子 Agent 能力。

日志还出现 `session.model_selection.persist_failed`（`FOREIGN KEY constraint failed`），但随后 `session.model.updated` 成功，且 Agent 与子 Agent 均实际运行；它不是本次失败主因，建议作为 ZCode 客户端的独立低优先级缺陷观察。

## 官方资料核对

ZCode 官方文档说明：

- ZCode 通过 `Agent` 工具启动内置 `general-purpose` 或 `Explore` 子 Agent；
- ZCode 支持 Anthropic／OpenAI 兼容的自定义 Provider；
- 官方文档未声明自定义 Provider 禁止子 Agent。

## 建议验证

完全退出并重启 ZCode，确保重新加载 Provider 配置；新建任务选择“仟流智算GLM”，发送：

```text
请明确调用 Explore 子 Agent，只读搜索项目中 gateway 的请求入口，并返回涉及的文件列表。
```

验收条件：

1. ZCode 界面出现 Explore／Agent 调用；
2. 日志出现 `subagent.spawned`；
3. 子 Agent 日志中的 `contextWindow` 不再是 `256`；
4. Gateway 在子 Agent 启动后出现对应的新增模型请求（`querySource=subagent` 是 ZCode 本地日志字段）；
5. 不再出现 `compact_rapid_refill_breaker`。

## 信息来源

1. ZCode 官方《Subagents》：https://zcode.z.ai/en/docs/subagents
2. ZCode 官方《Connect Models & Plans》：https://zcode.z.ai/en/docs/configuration
3. 本机 ZCode 3.7.3 配置：`~/.zcode/v2/config.json`（已隐去凭证）
4. 本机 ZCode 运行日志：`~/.zcode/cli/log/zcode-2026-08-08.jsonl`
