# Codex CLI CI 安装

- 收集时间：2026-08-04（Asia/Shanghai）
- 用途：仟流智算 Gateway 的 Codex 真实客户端 E2E

## 结论

Linux CI 不应依赖 macOS ChatGPT 应用内的 Codex 路径。CI 应安装官方 npm 包，并通过 `PATH` 调用 `codex`；本地特殊路径继续通过 `CODEX_E2E_BIN` 覆盖。

为保证测试可复现，当前固定官方 npm 包版本为 `@openai/codex@0.146.0`。

## 来源

- OpenAI Codex CLI 官方手册：[Codex CLI](https://learn.chatgpt.com/docs/codex/cli)
- OpenAI 官方 npm 包：`npm view @openai/codex version`，2026-08-04 查询结果为 `0.146.0`
