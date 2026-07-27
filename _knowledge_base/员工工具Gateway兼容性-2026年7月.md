# 员工工具 Gateway 兼容性调研

- 收集时间：2026-07-25
- 调研目的：确认 WorkBuddy、Claude Code、ZCode 是否允许员工填写仟流智算下发的 Base URL 与虚拟 Key，并通过仟流 Gateway 使用 DeepSeek、智谱、Kimi。

## 结论

三种员工工具在“客户端可配置性”上均具备接入条件：

| 员工工具 | 官方支持情况 | 仟流 Gateway 需要提供 |
| --- | --- | --- |
| WorkBuddy | 支持自定义 URL、API Key、模型名；默认使用 `/chat/completions`，也支持自定义协议路径 | OpenAI Chat Completions 兼容接口，或可直接请求的自定义接口 |
| Claude Code | 支持 `ANTHROPIC_BASE_URL`，支持以 `ANTHROPIC_API_KEY` 或 `ANTHROPIC_AUTH_TOKEN` 鉴权 | Anthropic Messages 兼容接口及流式、工具调用等必要语义 |
| ZCode | 支持自定义 Provider，可填写 Base URL、API Key，并选择 OpenAI 或 Anthropic 兼容协议 | OpenAI 或 Anthropic 兼容接口 |

因此，产品流程应固定为：

1. 管理员创建员工账号。
2. 系统为员工账号创建仟流虚拟 Key。
3. 管理员给员工分配 DeepSeek、智谱、Kimi 的可用权限与额度。
4. 员工在自己的工具中只填写仟流 Gateway 地址和自己的仟流虚拟 Key，通过模型名选择已分配的模型。

但“能填写”不等于“当前填完就一定能用”。要做到后者，仟流 Gateway 还必须完成并通过兼容性验证：

1. 对员工工具提供 OpenAI/Anthropic 兼容接口。
2. 将请求正确路由到 DeepSeek API、智谱 Coding Plan、Kimi Coding Plan。
3. 正确处理流式输出、工具调用、错误码、限流、取消与重试。
4. 按员工虚拟 Key 记录调用量、Token、费用与异常。

## 第一阶段应完成的验证

第一阶段做“可行性 POC”，不是等完整产品开发完再验证：

- WorkBuddy → 仟流 Gateway：普通对话、流式输出、工具调用、用量归属。
- Claude Code → 仟流 Gateway：普通对话、流式输出、工具调用、用量归属。
- ZCode → 仟流 Gateway：普通对话、流式输出、工具调用、用量归属。
- Gateway 上游分别验证 DeepSeek、智谱 Coding Plan、Kimi Coding Plan。

产品开发完成后，再做完整的客户端 × 模型回归验收。

## 风险边界

- 已确认：三个客户端均有自定义网关或自定义 Provider 的官方配置能力。
- 尚未确认：仟流 Gateway 尚未实现，因此不能声称九种“客户端 × 模型”组合已经端到端可用。
- 关键技术风险不在员工电脑采集，而在 Gateway 协议兼容、上游 Coding Plan 适配与用量归集。

## 信息来源

1. WorkBuddy 官方《Model Configuration》  
   https://www.workbuddy.ai/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/Model
2. Claude Code 官方《Environment variables》  
   https://code.claude.com/docs/en/env-vars
3. Claude Code 官方《LLM gateway configuration》  
   https://code.claude.com/docs/en/llm-gateway
4. ZCode 官方《Configuration》  
   https://zcode.z.ai/en/docs/configuration
5. Kimi Code 官方《Use Kimi Code Plan with third-party coding agents》  
   https://www.kimi.com/code/docs/en/kimi-code/models.html
6. 智谱官方《GLM Coding Plan FAQ》  
   https://docs.bigmodel.cn/cn/coding-plan/faq

