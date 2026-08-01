# Gateway 流式协议与 Kimi 限流稳定性

- 收集时间：2026-08-01（Asia/Shanghai）
- 调研原则：优先使用 Anthropic、OpenAI、Kimi 与 Caddy 官方资料。
- 用途：POOL-014 协议实现、超时边界、429 语义与反向代理配置依据。

## 结论

1. Anthropic Messages 流不是“若干 JSON 后关闭连接”这么简单。事件主序列是
   `message_start → content_block_start → content_block_delta* → content_block_stop → message_delta → message_stop`；
   工具参数使用 `input_json_delta`，流中错误使用 `event: error`。
2. OpenAI Chat Completions 的流式响应由 Chat Completion Chunk 组成，以
   `data: [DONE]` 结束。请求 `stream_options.include_usage=true` 时，结束前会有
   `choices=[]` 的最终 usage chunk；流被中断时该 chunk 可能缺失。
3. OpenAI Responses 有自己的原生事件体系（例如 `response.created`、
   `response.output_text.delta`、完成/错误事件），不能把 Chat Completions SSE
   改个接口名就宣称原生兼容。
4. Kimi 官方把 429 区分为服务过载、并发、滚动窗口和月额度等原因，并建议遵循
   `Retry-After` 或指数退避。Gateway 应保留 429 与 `Retry-After`，不能改写成
   “模型不存在”或把唯一资源长期熔断。
5. Caddy 对 SSE 可立即刷新；`reverse_proxy` 的 `flush_interval -1` 可显式关闭响应
   缓冲。Caddy 本身没有默认的流总时长上限，因此生产约 60 秒 404 仍需结合
   Gateway、反向代理及 Kimi request ID 分层定位，不能只凭现象归因。

## 对仟流智算的实现约束

- `/v1/chat/completions`：上游合法 SSE data 到达后立即改写请求 ID/模型并转发；
  保留 finish reason、工具调用、最终 usage 与 `[DONE]`。
- `/v1/messages`：实时转换为 Anthropic 事件序列；文本与工具块按协议开闭，最终
  usage 放在 `message_delta`，以 `message_stop` 结束。
- `/v1/responses`：当前只支持 Responses 子集到 Chat Completions 的转换，属于
  `TRANSFORMED`，不支持原生托管工具和原生事件透传。Codex 当前应优先通过
  CC Switch 转为 Chat Completions；需要原生 Codex 兼容时另立原生 Responses 工作项。
- 超时分三层记录：首字节、流式空闲、请求总时长。HTML、网络异常和超时只输出
  稳定 JSON/SSE 错误，原始错误正文不入库、不回传。
- 诊断只记录协议、stream、客户端标识、首字节时间、失败层、上游状态码和
  request ID；不记录消息正文。

## 官方来源

1. Anthropic，Streaming Messages：
   https://platform.claude.com/docs/en/build-with-claude/streaming
2. OpenAI，Chat API reference（stream 与 `stream_options.include_usage`）：
   https://developers.openai.com/api/reference/resources/chat
3. OpenAI，Responses streaming events：
   https://platform.openai.com/docs/api-reference/responses-streaming/response/refusal/delta?lang=curl
4. Kimi Code，Error Reference：
   https://www.kimi.com/code/docs/en/kimi-code/error-reference.html
5. Kimi，API Troubleshooting：
   https://www.kimi.com/help/kimi-api/api-troubleshooting
6. Caddy，`reverse_proxy`（streaming / `flush_interval`）：
   https://caddyserver.com/docs/caddyfile/directives/reverse_proxy
