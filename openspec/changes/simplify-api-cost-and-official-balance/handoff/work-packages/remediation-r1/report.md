# 返修轮 R1 结包报告：验收退回整改

轮次：R1（验收退回整改）；总指挥：GLM-5.3；实施：glm-flash 串行 R1 调查→R2→R3→R4→R5→R6→R7→R8a 全量→R8b-1 w18 补修。日期：2026-11-05。授权：用户（"同意，依然采用总指挥＋子 Agent 修复"）。

## 1. 输入与结论

- 输入：验收退回意见（development-summary.md §6，验收人 Kimi Code 2026-11-05，提交 `686100f`）——四项功能阻断＋W20-10 归因不接受＋验收资产纠正＋备份恢复演练要求。
- 总指挥逐项核实：六项指控全部属实（含撤销我方"路径零触碰"错误定性）。
- **结论：返修完成，交回验收人复审。** 四阻断＋租约收敛全部修复并留负向回归；W20-10 归因按验收要求改"尚未闭合"＋同机 A/B（贡献证实）；矩阵统一口径不再维持 50/50；整库备份恢复两路线实测通过；全量终态证据齐备（§3）。

## 2. 修复对照（验收意见 → 修复 → 证据）

| 验收意见 | 修复（提交内） | 负向/修复回归 | 证据 |
|---|---|---|---|
| 1 OAB-01/AFR-01 冒充 | 客户端合同 source 字面 ADMIN（三入口）；O1a 服务端全枚举保留；读侧三处双滤 balance_source='PROVIDER_API' | 400 拒绝×3（零落库）＋冒充行免疫×3（官方域/预测/恢复链） | w04 17/17、states 9/9、forecast 5/5、runner 4/4 |
| 2 ACE-04/D1 补零 | computeApiCostFromRule 适用分项缺价→null→UNKNOWN_COST（api_cost NULL）；CONFIRMED_ZERO 不入 PRICE_BASIS_UNVERIFIED | 验收场景反转＋cache=0 保持＋X06 复跑 12 金额行逐字一致 | domain 413/413、estimation 14/14 |
| 3 ACE-02 现值依据 | 聚合读快照 `->>'sourceStatus'` 移除 JOIN；旧行缺键→UNVERIFIED | i-a 历史追溯＋i-b 旧行回退＋0091 探针决定性证明 | estimation 13/13、DB 下游 83/83 |
| 4 OAB-04 租约 | SYNCING 加 expires_at>now，过期回落 | 过期/未过期/无快照三段 | states 9/9 |
| 5 W20-10 | 三处文档撤回零触碰；A/B 四样本：候选 1159ms vs 旧基线 812ms（+42.8%，候选 2/2 FAIL vs 旧基线 2/2 PASS）——**贡献证实**；CI 四项全过为解除条件 | 归因未闭合如实 | logs/23-27 |
| 6 资产纠正 | matrix.md 单一口径＋沿革；5 条受影响条目标"R1 退回→修复→复核，终态待复审"；matrix-r1.md 新建（8 行：7 PASS 回归已执行＋H 部分）；8 张陈旧截图移 superseded/；development-summary 全口径更新 | — | matrix.md/matrix-r1.md |
| 6 备份演练 | 隔离库两路线（.sql.gz gunzip|psql 与 -Fc pg_restore）各 14/14：迁移头 0096/八行集摘要逐字一致/备份后新增消失/无需 down | — | logs/28＋backups/ |

## 3. 全量终态（R8a＋w18 补修）

domain 413/413、adapters 398/398、config 15/15、database 单测 245/245＋集成 610/613、control-api 363/364、gateway **250/250**（R8a 发现 w18 2 条 F2 夹具冲突→裁定补价不补断言→33/33 复绿）、worker 201/201、web 773/773＋e2e 16/16、七包 typecheck/lint 全 0、openspec strict valid。已知红如实单列：W20-10 P95（触发断言换位 subjectUsage 1029.98>800，震荡延续）；usage-aggregate-migration-capacity 600s 超时（容量族）；CA AT-X02 一条＝环境时钟假阴性（宿主-testcontainer 偏移 ~1.2s，同代码当日早间 32/32、探针实证，非产品回归）。

## 4. 总指挥独立复核记录

R2 关键负向复跑 17/17＋9/9；R3 estimation 复跑 14/14；R4 billing-rule/estimation 复跑 44/44＋14/14；R5 三文档 diff 逐行核验（边界干净、原始记录保留）；R6 装配审定（无条目擅自改判 PASS）；R7/w18 抽核（w18 零断言改动）。R8a 全量由子 Agent 跑批＋总指挥审阅归因。

## 5. 遗留与决策点（交用户/验收人）

| # | 项 | 状态 |
|---|---|---|
| 1 | **W20-10 性能决策点**：A/B 证实 utilization 端点 P95 劣化 +42.8% 系本变更逐资源 N+1 估算查询（query.ts:331-343）——CI 复验大概率不过 1000ms 阈值。选项：a) 授权性能修复（改一次批量 loadApiCostEstimation＋按资源分组，改动小）；b) 先 CI 实测定论。**发布阻断维持直至 CI 四项全过** | 待用户裁定 |
| 2 | AT-X02 时钟脆弱点：收敛判定建议改用 DB 侧 now()（本轮环境假阴性归因留证，未改代码） | 待裁定 |
| 3 | R2 幂等指纹跨发版重放 miss（低风险）；非官方域消费方仍读冒充存量行（验收口径外）；补零历史行识别口径（AFR-06 不重算） | 记录在案 |
| 4 | rollback.sh 期望头 0045 需按备份点定制＋两种备份制品格式统一 | 发布前置（既有） |
| 5 | 间歇 403 flake（w18 三轮，低负载消失，HEAD 基线同现）＋colima VZ 时钟同步 | 环境项记录 |

## 6. 提交

- `ea45c4f`（业务修复主体）：F1/F4（contracts 拆分/双滤/租约）＋F3（快照依据）＋F2（缺价）＋w18 夹具补价＋大部分新增回归（23 文件 +477/−43）。
- `7ceb97e`（文档/证据）：remediation-r1 全套（plan/inv/matrix-r1/report/logs 01-32/backups）＋development-summary/matrix/release-candidate/WP5 report 更新＋截图 superseded 移动（43 文件 +2911/−53）；**另含 4 个测试文件**（w04-provider-route/wp2-pending-admission/attempt-usage-settlement/billing-evidence）——首笔 add 路径遗漏所致，归属上属业务修复的回归测试，两笔合计完整（如实记录）。
- 分支：修复期间曾在临时分支 `remediation-r1-f1-f4` 工作，已合回 `codex/simplify-api-cost-and-official-balance`，临时分支已删；终态工作树 tracked 零未提交。
