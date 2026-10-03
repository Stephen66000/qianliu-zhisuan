# Proposal

> 2026-10-03，v1.1；`PLAN_REVIEW_PASS / IMPLEMENTATION_NOT_AUTHORIZED / DEPLOYMENT_NOT_AUTHORIZED`。
> 计划来源：`V4/Coding-Plan窗口额度提示与自动恢复开发计划-v1.1-20261003.md`；源码基线 `7f3557f7afabcd6665aea39932895899272e318b`。

## Why

现有Coding Plan自动恢复已经运行，但首次耗尽和等待期重试不能稳定表达具体窗口与恢复时间。需要统一提示、持久阻断和可信恢复，原Key无需管理员操作就能在厂商恢复后继续调用。

## What Changes

- 对Kimi／智谱5小时、周、双窗口和未知套餐耗尽返回准确北京时间提示。
- 统一首次、隔离重试、准入及三协议语义；时间只安排GET检查，不等于已恢复。
- 最小当前耗尽记录加额度revision，在窗口缺失／重启时保留阻断，按当前凭证及故障确认正余量解除。
- 明确耗尽EXHAUSTED硬门禁；PLAN_ONLY在初始选路到Attempt全路径排除隐式付费API。
- 窗口、资源、原Key模型与同incident额度事件条件事务提交，旧结果不覆盖新故障。
- 现有Worker任务独立捕错；无需新增调度服务。初审4P1与3P2由design.md的D1—D7关闭。
- 本轮只修订文档与复审，v1.0及初审记录保留，不实施上述变更。

## Capabilities

### New Capabilities

- `coding-plan-quota-windows`：把已有窗口能力的提示、自动恢复及额外计费边界正式定义为可验收规格。初审CLI主规格清单为空，不猜测其他主规格路径。

### Modified Capabilities

无；不修改其他在途变更或主规格。

## Impact

- Gateway准入、错误呈现、Provider归一化、Worker、窗口／资源恢复仓储及适用事件。
- 北向兼容字段和code映射冻结于计划§3；初始混合CP/API路由的隐式付费行为改为PLAN_ONLY，API-only不改。
- 明确最小additive迁移三列：资源quota_block_state、quota_state_revision及事件quota_block_incident_id，候选0087，实施前重核编号。本轮不写迁移文件。
- 不追查历史403、不新增首页、付费UI或存储平台、不修改历史账本。
- 实施与部署尚未授权，初审和v1.1复审分别保留于 `V4/Evidence/CODING-PLAN-QUOTA-WINDOW-20261003/`。
