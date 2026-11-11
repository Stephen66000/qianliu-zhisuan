# v1.5 代码质量预检整改计划（Contract 与预算）

依据：`交接/V1.5代码质量预检-20261107/zcode整改与送审指令.md`＋审核报告（预检不通过：CQ-01/GATE-01/Evidence Gap）。执行：Planning/总指挥 GLM-5.3；整改实施 GLM-5.3-Flash（glm-flash）；正式质量结论归验收人。

## 0. 基线（2026-11-07 核实）

- 候选（预检对象）：`d82559f09aab75bac6a1e1e9d80b228d56c0f057`＝当前 HEAD，工作树干净。
- 门禁对账：`node scripts/check-source-size.mjs` 独立复跑＝10 项失败，与审核报告逐项一致。
- 运行时：项目声明 Node 22.23.4——本机已装（nvm v22.23.4，default alias）；后续命令以 `node -v` 回显记录。预检时 22.17.1 的结果不复用为冻结环境证据。
- X07 现状：正确参数路径功能复判 18/18（R4+R5，验收人）；CQ-01 属新数据安全证据，独立处理不拒不做。

## 1. 冻结预算（指令 §二建议值，非用户逐项确认）

| 项 | 值 |
|---|---|
| max_fix_batches | **1**（CQ-01＋GATE-01＋材料准备同批） |
| max_reaudit_rounds | **2** |
| wall_clock_minutes | **420**（依据：CQ-01 红绿约 60'；GATE-01 十文件最小拆分约 180'；材料与对象锁约 60'；总指挥独立复验约 60'） |
| budget_hit_action | STOP_AND_REPORT（到限即停，不扩容、不删检查） |

## 2. 批次内容与 Owner

| 组 | Owner | 文件范围 | 验证命令 | 预期 |
|---|---|---|---|---|
| CQ-01 影子库保护 | glm-flash | deploy/scripts/rollback-delta-20261106.sh＋其调用测试＋操作单 §6.1/§6.4 | 命令桩负向（缺 live/shadow=live/冲突输入→任何破坏或失败清理前 exit≠0 且无 dropdb/写入/改名）；隔离库正路径；X07 主路线 11 用例＋原 down 链 7 用例 | 红证（d82559f 快照）→绿全过；旧断言零删减 |
| GATE-01 体量门禁 | glm-flash（按包串行 3 份合同） | 审核报告 §2 的 10 文件＋其直接调用方 | `node scripts/check-source-size.mjs` 退出 0；`node scripts/check-architecture.mjs`；受影响包 typecheck/lint/定向测试 | 逐项处置表（拆分或例外待决）；不抬基线不绕门禁 |
| 送审材料 | Planning（总指挥） | handoff/code-quality-v1.5/＋Evidence CODE-QUALITY-V15-20261107/ | candidate_lock generate+verify（STABLE）；门禁证据逐项（范围/命令/版本/阈值/结果/差异/证据） | 材料就绪；账本握手不提前执行 |

## 3. 红线

不新增产品功能/迁移/回放框架；不调 API 估算、额度算法、价格、同步默认值；不处理未确认 P2/P3；例外未经确认＝待决不记 PASS；对象锁在整改候选提交后生成；`CODE_AUDIT_IN_PROGRESS` 握手仅在正式 Reviewer 就绪时由 Planning 原子执行；不宣布 v1.5 PASS、不归档、不推送合并、不部署。

## 4. 运行记录（随进度填写）

- fix_batches_used: 0/1
- reaudit_rounds_used: 0/2
- started_at: 2026-11-07（墙钟自委派 CQ-01 起算）
