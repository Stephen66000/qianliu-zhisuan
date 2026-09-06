# 第二轮 I1 功能复审回传

Reviewer `/root/operating_v14_review`，只读复审，未参与整改。主会话据原始回传归档。

结论：**PASS；F1、F2、F3、E1 全部关闭。** 范围限本轮冻结修复及原候选功能合同，不代表代码质量门禁或生产验收通过。

候选 `candidate-r2.json`，摘要 `d41e7a8ed6ab3315f3feda8a89045223d25e1663714be97b70d3642e9d99944b`。开审复读 state_version=3、round=2、FUNCTIONAL_AUDIT_IN_PROGRESS；首尾64/64 SHA匹配，仅6个原候选文件变化。结束时间2026-09-06 15:44:54.928 UTC。

- F1：资源级UNKNOWN计数优先使账户分摊返回null并传到员工、项目、部门、下钻；旧概览199元全量未分配加gap，符合原字段实际已分配合同。
- F2：固定两家，任一null则综合null。
- F3：负责人仅以姓名存在判断，允许personId为null，冻结前后保持一致。
- E1：夹具改用数据库时间上取下一毫秒，保留原研发部5Token/2元、售前部7Token/3元及目录更新断言。本候选38项全部通过。

已独立读取regression-red.log的原产品3项失败和backend-coverage-r2.log的38项通过/覆盖退出1，确认未弱化断言。Reviewer未重复运行这批命令。覆盖、ratchet和增量Mutation缺口仍存在，等待主会话代码审核握手后给出正式结论。
