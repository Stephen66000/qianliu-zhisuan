# 运行保障与管理员存档清理 I1 代码质量审核合同

- audit_id: `RUNTIME-ADMIN-V14-I1-20260908`
- session_type: `review`
- audit_round: `i1-initial`
- callback_target: `/root`
- risk_level: `R3`
- required_independence: `I1`
- actual_independence: `I1`
- reviewer: `/root/i1_runtime_admin_review`
- base: `4cea87f`
- reviewed_object: `candidate-lock-final2.json`
- implementation_hash: `486445fccbddc636341bcec2ebdeae8fc9c8d7f1615d2c96c3aed9dfbbbdc72d`
- manifest_hash: `3ede373a5d09e9b78e7f5bcef86bcba0bca2eef9910516fd176787c3116e031d`
- quality_gate_config: `V3/仟流智算-质量门禁-v1.0.json`
- coding_standard: `AI编码工程规范-通用版-v1.4.md`

## 功能前置交接

本次是用户明确要求的有界 I1 代码质量审核。功能前置采用：用户已确认异常中心及管理员清理原型；同一最终候选的 Web、Control API、PG17 迁移直接回归已经通过。该交接只证明本轮代码审核输入具备，不替代生产验收、部署验收或完整阶段功能 Audit。

## 审核范围

只审核 manifest 中的异常中心、异常详情、管理员存档清理、0065/0066 迁移、直接类型及测试，并读取必要上下游。额度计价、企业微信通知、其他 V4 Evidence、提交、推送、部署和生产数据库均不在范围内。

## 禁止动作

不修改产品代码、测试、最终 manifest、已有 I0 Evidence 或权威文档；不提交、推送、部署、降低阈值或自行修复 Finding。允许在 `V14-I1/` 写独立审核 Evidence 和运行安全只读门禁。

## 退出条件

完成 V1.4 阅读矩阵、一次性冻结 Findings、首尾对象锁核验，并回传 `PASS / FAIL / BUDGET_HIT / OBJECT_DRIFT`。
