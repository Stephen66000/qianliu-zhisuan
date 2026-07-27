# 仟流智算 Stage 01 独立性门禁豁免决定

| 项目 | 内容 |
| --- | --- |
| 项目／版本 | 仟流智算 v0.3 |
| 决定时间 | 2026-07-27 00:03（Asia/Shanghai） |
| 决定人 | 佳哥 |
| 决定人角色 | 产品负责人、业务代表、技术负责人 |
| 原候选 | [Stage 01 v0.3.1 豁免前候选锁](./仟流智算-Stage01评审候选锁-v0.3.1.pre-waiver.sha256) |
| 决定 | `OWNER_APPROVED`；`INDEPENDENCE_GATE_WAIVED` |
| SOP 合规标记 | `DEVIATION_RECORDED`；不得表述为“独立 Reviewer 已 PASS” |
| Planning Change | `PC-20260727-03` |

## 1. Owner 原始决定

> Owner 已批准、独立性门禁被豁免

该决定由佳哥在当前项目会话中明确作出。佳哥此前已按产品负责人、业务代表和技术负责人三角色签署 WT-01～20 全部 PASS。

## 2. 生效范围

- Stage 01 按 Owner 风险接受口径完成运营性封板；
- 允许进入 Stage 02 开发计划正式评审；
- Stage 01 正式独立 Reviewer 结论保持为空，不伪造 `READY`／`READY_WITH_ACTIONS`／`NOT_READY`；
- POC-02 的 `OWNER_ATTESTED_LEGACY_RESULT` 仅被 Owner 接受为进入开发计划的风险，不等于 Provider 上线 Evidence。

## 3. 不生效范围

本决定不豁免：

- Stage 02 开发执行就绪评审；
- Stage 03 及后续工作包自检、功能／验收 Review、技术 Audit 或代码质量 Audit；
- 真实 Provider 上线前的凭证回归；
- Windows 客户端最终签字；
- 真实生产流量、真实扣费、发布、push、PR 或 merge 授权；
- P0／P1 事实、缺失 Evidence 或安全／数据风险。

## 4. 复查触发

以下任一情况发生时，Stage 01 Owner 封板失效并返回 Planning：

- 产品目标、scope／non-scope、关键架构、安全、数据、验收或真实业务周期发生实质变化；
- Stage 02 评审发现 Stage 01 阻断性 Evidence Gap；
- POC-02 当前凭证回归推翻三类上游可行性；
- 正式封板锁校验失败。
