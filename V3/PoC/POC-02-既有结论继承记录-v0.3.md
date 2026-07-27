# POC-02 既有三类上游结论继承记录

| 项目 | 内容 |
| --- | --- |
| 记录日期 | 2026-07-26 |
| 决策 Owner | 佳哥（产品／技术） |
| 继承对象 | DeepSeek API、智谱 Coding Plan、Kimi Coding Plan 的既有真实凭证可行性结论 |
| 当前证据等级 | `OWNER_ATTESTED_LEGACY_RESULT` |
| 是否可复跑 | 否；旧任务未保留临时凭证、原始响应和可定位的旧 Evidence 文件 |

## 1. 继承事实

佳哥明确确认三类上游此前已完成真实凭证可行性验证，该结论是它们进入 PRD／TRD 的业务与技术依据。本轮只继承“可以进入 Adapter 开发和离线契约设计”的判断，不继承具体模型版本、响应样本、性能数字或上线保证。

由于旧任务没有留下可定位的 Evidence 文件，本记录不能冒充原始 PoC。它只把“谁在何时决定继承什么、没有继承什么”固定下来，避免继续依赖聊天记忆。

## 2. 本轮可独立复核的新增证据

- [安全注入实现](./persistent-gateway/src/provider-secrets.mjs)：三厂商 Secret 只从环境变量读取；
- [集成测试](./persistent-gateway/test/integration.test.mjs)：使用 canary 验证序列化强制输出 `[REDACTED]`；
- [POC-02 Evidence](./POC-02-三类上游-Evidence.md)：明确真实流量前的逐 Provider 回归合同；
- [项目工程规则 §5](../仟流智算-项目工程规则-v0.3.md#5-配置密钥与数据)：正式 Secret Manager／Docker Secret 注入边界。

## 3. 不继承与停止边界

以下事项不由历史结论证明：

- 当前模型列表、限流、usage、工具调用和流式事件仍与旧验证一致；
- 当前凭证有效；
- Provider 已满足生产上线条件；
- Windows 客户端或四类客户端已经完成真实 E2E；
- 三类资源可以绕过开发期自动化回归。

任一 Provider 在真实上线回归中出现鉴权、模型、流式、工具调用、usage、429／额度、健康探测、错误映射或凭证轮换失败，只停止该 Provider 上线，不回溯阻塞 Gateway、账本、Web 和其他 Adapter。
