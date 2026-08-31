# Claude Desktop 通过 CC Switch 调用 Kimi K3 故障

- 收集时间：2026-07-31 23:58（Asia/Shanghai）
- 现象：Claude Desktop 提示 `There's an issue with the selected model (claude-fable-5)`。

## 结论

这不是 `claude-fable-5` 不存在或用户没有模型权限。它是 CC Switch 暴露给 Claude Desktop 的本地占位模型 ID，实际请求已经被正确映射为仟流 Gateway 的 `Kimi`。

本次是两类上游稳定性故障被 Claude Desktop 包装成了“所选模型有问题”：

1. 23:49–23:50 的连续请求均在约 60.3 秒后收到上游 HTTP 404 HTML 页；
2. 当天下午还多次出现 Kimi HTTP 429 `engine_overloaded_error`，随后仟流 Gateway 因单 Kimi 资源被置为不可用而返回 503 `no_healthy_candidate`。

当前链路已恢复。通过 CC Switch 本地端点，以 `claude-fable-5` 分别发起非流式和 `stream:true` 最小请求，均返回 HTTP 200，响应中的实际模型为 `Kimi`。

## 本机证据

1. CC Switch 当前 Claude Desktop Provider 为 `Qianliu`，使用模型映射模式：
   - `claude-fable-5` → `Kimi`
   - `claude-opus-5` → `Kimi`
   - `claude-sonnet-5` → `Kimi`
   - `claude-haiku-4-5` → `Kimi`
2. `GET http://127.0.0.1:15721/claude-desktop/v1/models` 返回 HTTP 200，包含 `claude-fable-5`。
3. CC Switch 请求日志明确记录请求目标为 `https://gw.qianliuai.com/v1/messages (model=Kimi)`。
4. 23:34:58 同一映射请求成功：HTTP 200，input 13,423 tokens、output 1,009 tokens、耗时 45.856 秒。
5. 随后三次失败均在约 60.26–60.29 秒返回 404 HTML，并非模型校验阶段立即拒绝。
6. 23:54 后端到端最小测试成功：
   - `claude-fable-5` → `Kimi`，HTTP 200，返回 `CC_K3_OK`；
   - `stream:true` 请求同样 HTTP 200，返回 `STREAM_K3_OK`。
7. 使用同一主体 Key 直接调用 `POST https://gw.qianliuai.com/v1/messages`，模型 `Kimi`，返回 HTTP 200。

## 进一步判断

仟流 Gateway 当前收到 `stream:true` 时仍返回一次性 `application/json`，没有返回 Anthropic SSE 事件流；也就是说，Gateway 对 `/v1/messages` 的流式能力存在“声明支持、实际缓冲”的差异。K3 较长响应需要几十秒，非真实流式链路更容易撞到约 60 秒的上游／反向代理超时。这个现象与本次每次 60 秒后失败高度吻合，但 404 HTML 的最终产生层仍需结合生产 Gateway 和 Kimi 上游访问日志确认。

## 建议修复顺序

1. Gateway 为 `/v1/messages` 落地真实 Anthropic SSE 透传，不能忽略 `stream:true`。
2. 把上游超时明确映射为 504／`upstream_timeout`，不要让 HTML 404 穿透到 Claude Desktop。
3. 修复 Kimi 单资源熔断：429 只做短时限流冷却，不应直接导致全模型 `no_healthy_candidate`。
4. 增加第二个 Kimi 资源或可切换候选，避免单资源故障放大。
5. 日常任务可评估增加 `k3-256k` 路由；Kimi 官方称其在 256K 内效果相同且额度消耗更低。

## 来源

1. CC Switch 官方 Claude Desktop 文档：模型映射模式会向 Desktop 暴露安全的 Claude 角色 ID，再映射为真实 Kimi 模型。  
   https://github.com/farion1231/cc-switch/blob/main/docs/user-manual/en/2-providers/2.6-claude-desktop.md
2. Kimi Code 官方 Claude Code 接入文档：即使客户端显示 Claude 模型名，实际请求仍可路由到 Kimi；当前模型包括 `k3`、`k3-256k` 等。  
   https://www.kimi.com/code/docs/en/third-party-tools/claude-code.html
3. Kimi Code 官方错误参考：第三方客户端可能重新包装错误；`engine overloaded` 对应 HTTP 429。  
   https://www.kimi.com/code/docs/en/kimi-code/error-reference.html
4. 本机 `~/.cc-switch/cc-switch.db`、`~/.cc-switch/logs/cc-switch.log` 与仟流 Gateway 实测，2026-07-31。
