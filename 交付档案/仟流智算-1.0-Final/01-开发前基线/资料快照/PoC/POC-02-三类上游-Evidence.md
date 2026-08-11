# POC-02 三类上游 Evidence

- 结论确认时间：2026-07-26
- 业务／技术决策 Owner：佳哥
- 状态：**ACCEPTED_FOR_STAGE01**

## 结论

佳哥确认 DeepSeek、智谱、Kimi 已在此前 PoC 中完成可行性验证，相关结论正是三类上游进入 PRD/TRD 的依据。本次不因当前进程没有注入临时凭证而推翻已确认 PoC，也不要求在聊天或 Markdown 中重新提交密钥。

旧任务记录没有保留可复跑的明文凭证或完整原始响应；本文件不伪造历史输出。Stage 01 按产品/技术 Owner 的既有 PoC 结论验收，真实流量上线前再由 Provider Adapter 自动化回归。

继承范围、证据等级、不继承事项和停止边界已固化到[既有结论继承记录](./POC-02-既有结论继承记录-v0.3.md)。该记录解决结论来源的可追溯性，但不把 Owner 确认升级为可复跑的原始 PoC。

## 已补安全注入入口

[provider-secrets.mjs](./persistent-gateway/src/provider-secrets.mjs) 已实现三厂商环境变量入口：

| Provider | Secret 入口 | Base URL 入口 |
|---|---|---|
| DeepSeek | `DEEPSEEK_API_KEY` | `DEEPSEEK_BASE_URL` |
| 智谱 Coding Plan | `ZHIPU_CODING_TOKEN` | `ZHIPU_CODING_BASE_URL` |
| Kimi Coding Plan | `KIMI_CODING_TOKEN` | `KIMI_CODING_BASE_URL` |

约束：

- `.env` 已加入 `.gitignore`；
- 代码只返回“是否配置”和变量名，不打印 Secret；
- Secret 对象 `JSON.stringify` 强制输出 `[REDACTED]`；
- 集成测试使用 canary 凭证验证序列化零泄露；
- 正式部署改由 Secret Manager/Kubernetes Secret 注入，接口名称保持不变。

## 开发期强制回归

在任何真实流量或真实扣费启用前，每类 Adapter 必须使用临时凭证回归：鉴权、模型、流式、工具调用、usage、429/额度耗尽、健康探测、错误映射和凭证轮换。失败只阻塞该 Provider 上线，不回溯阻塞其他模块开发。

## 判定

既有三厂商 PoC 结论沿用，安全注入入口已落地，**POC-02 不再阻塞 Stage 01**。
