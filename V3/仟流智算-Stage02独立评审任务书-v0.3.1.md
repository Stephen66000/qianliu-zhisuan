# 仟流智算 Stage 02 独立评审任务书

| 项目 | 内容 |
| --- | --- |
| 评审类型 | 开发执行就绪评审 |
| 产品／计划版本 | v0.3／v0.3.1 |
| 当前状态 | `AUDIT_COMPLETED`；等待 Owner 对整改候选作最终决定 |
| Reviewer 要求 | 未参与当前计划作者链的新 AI 会话；只审不改 |
| 上游前置 | Stage 01 已完成独立审核、主 AI 整改和 Owner 放行 |
| 上游 Evidence | [Stage 01 Owner 最终放行决定](./仟流智算-Stage01-Owner最终放行决定-v0.3.3.md) |
| 已审核对象 | [Stage 02 v0.3.2 评审候选锁](./仟流智算-Stage02评审候选锁-v0.3.2.sha256) |
| 审核输出 | [ZCode Stage 02 SOP 合规审核报告](../仟流智算-Stage02-SOP合规审核报告-20260727.md)；建议 `NOT_READY` |
| 整改候选 | [Stage 02 v0.3.3 整改候选锁](./仟流智算-Stage02整改候选锁-v0.3.3.sha256) |
| Owner 决策档 | [Stage 02 开发执行就绪评审](./仟流智算-Stage02开发执行就绪评审-v0.3.md) |

## 评审问题

只回答：

> Stage 01 的方案是否已经被正确转化为可以直接执行、持续验证和有界收口的开发计划？

ZCode 已作为未参与 Stage 02 作者链的另一个 AI 完成本任务。按 SOP §3.2.1，ZCode 不需要进入主任务或直接修改项目评审档；审核报告、v0.3.2 对象锁、整改记录和 v0.3.3 新锁共同构成审核链。

## 必查范围

1. 候选锁与实际文件一致。
2. 产品目标、scope／non-scope 没有偏离 Stage 01。
3. M1～M8 是纵向闭环；W01～W29 足以执行、验证和交接。
4. 约 82 个 AI 小时、P50 4 天／P80 5 天的估算依据成立，外部门禁未混入 AI 编程工期。
5. Owner、依赖、输入输出、DoD、测试、Evidence 和集成顺序明确。
6. 真实业务周期有事件日历、十五项指标、数据源和实名 Owner。
7. M1～M6 HIGH、M7 最终候选的 Review／Audit 强度符合 SOP。
8. 工程版本、命令合同、Git、密钥、数据、安全、权限和禁止事项可执行。
9. 当前状态、Planning Change、唯一下一动作和 Stage 03 授权边界一致。
10. Windows、真实 Provider、域名服务器和 10 人入组只阻塞对应验收，没有成为假全局阻塞。
11. Stage 01 独立审核建议、整改结果和 Owner 最终决定已分别保留，未把三者混写成一个结论。

## Owner 下一动作

- 核对 ZCode 原始报告，不改写其 `NOT_READY` 建议；
- 核对主 AI 对有效问题的整改和新候选锁；
- 决定 `OWNER_APPROVED`／`OWNER_APPROVED_WITH_ACTIONS`／`OWNER_REJECTED`；
- 在 Owner 决定前，Stage 03、W01 和产品业务编码保持禁止。
