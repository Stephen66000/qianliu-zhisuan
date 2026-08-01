# RA-W04 Gateway 纵向熔断 Evidence

- 时间：2026-08-01 08:51 Asia/Shanghai
- 实现：真实 OpenAI-compatible HTTP Caller 按资源选择智谱／Kimi endpoint；只解析允许的业务码、`Retry-After`、`resetTime` / `next_flush_time`；规范化信号进入规则、幂等事件和 Outbox。
- 安全边界：智谱已验证业务码显式映射；Kimi 只使用已验证通用字段，不猜测业务码；原始错误正文不落库、不回传、不进普通日志。
- 客户端合同：OpenAI 与 Anthropic 外层协议分别保留，统一返回中文原因、`recover_at`、`event_id`和可用时的 `Retry-After`。
- 本地实例：`request_id=c2bfff25-8890-4afd-9966-16793bda8114`，`event_id=BRK-20260801-D7DEE23F`（临时本地测试库，已销毁）。
- 验证：Provider Adapter 65/65；Gateway 单测／集成 109/109；显式集成集 106/106；RA 纵向定向 3/3。
- 重要回归：连续普通 5xx／超时只写 `DEGRADED + alert_event`，不产生活跃硬熔断事件。
- 风险：真实厂商信号回归仍需 Owner 提供独立测试资源；本轮没有使用真实流量或产生扣费。
- 结论：本地开发门禁 PASS，厂商真实上线签字 PENDING_EXTERNAL。
