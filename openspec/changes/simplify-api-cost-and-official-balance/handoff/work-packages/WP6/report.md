# WP6 结包报告：发布候选与切换/回退演练（task 6.3）

包：WP6；总指挥/模型：GLM-5.3（zcode 会话）；实施：glm-flash 子 Agent（GLM-5.3-Flash，thoughtLevel: high）串行 S0 探针→S1 调查→S3 X07→S4 X08→S2 成文→S5 复验＋一次 lint 返工；生产补核（S6）由总指挥准备命令清单待用户回执。日期：2026-11-04～05。**结论：通过**（X07/X08 BLOCKED 半段补齐、矩阵 50/50；W20-10 复验 FAIL 如实记录不放宽阈值；生产补核未核实待回执，单列不冒充）。

## 1. 基线与工作区状态

- 起点：HEAD `59f7367`（＝WP5 结包 `f6e3c33`＋联审补遗 `5c50aa7`＋走查修复 `715e5d0`/`da36ac4`/`68d2227`＋签收归档 `59f7367`；开工复核：分支 `codex/simplify-api-cost-and-official-balance`、工作树净、`ae506fe` 为 HEAD 祖先、远端 main 仍 `ae506fe` 无前进、迁移水位 0096）。
- 业务签收走查已由用户回传 PASS（WP5 §6 走查更新＋walkthrough-signoff-20261104.md）；OAB-13 文案已由 D-4 修复（task.md 附"尚未回传"口径过时，本报告按回执现状记录）。
- 环境：colima 高负载贯穿全程；容器测试环境变量 `DOCKER_HOST=unix:///Users/mac/.colima/default/docker.sock`＋`TESTCONTAINERS_RYUK_DISABLED=true`；走查遗留服务（5173/8788）占用端口——全程避让（e2e 用 playwright 原生端口覆盖 8799/5199；X08 用 187xx/287xx 段），未杀用户进程。
- 旧基线 worktree：`/Users/mac/Projects/仟流智算-wp6-legacy-ae506fe`（`git worktree add --detach` 检出 ae506fe；pnpm install frozen-lockfile 零差异；全程零提交零文件改动，终查 status 干净；**保留待用户处置**——其存在是 X07 旧代码实证的复现前提）。

## 2. 计划 vs 实际交付（plan.md §4 阶段表对照）

| 阶段 | 计划 | 实际 | 证据 |
|---|---|---|---|
| S0 探针 | glm-flash 可用性 | PASS（HEAD＋WP5 §5 摘要双任务回报合格） | 会话记录 |
| S1 调查 | 候选素材/演练回溯/W20-10 定位/D-1~D-4 影响面 | 完成：五部分 A-E 全带 file:line；纠正 WP0 baseline 笔误（水位表＝kysely_migration 非 knex_migrations）；发现 D-3/D-4 文案无自动断言（走查回执"组件测试覆盖"表述与代码现状不符） | notes/inv-wp6.md |
| S3＝X07 回退半段 | down 链演练＋0095 守卫两态＋0094 边界＋旧代码实证 | 完成：新增 `wp6-rollback-drill.integration.test.ts`（537 行 7 用例，长期资产）＋旧代码实证脚本/日志；总指挥独立复跑 7/7 同绿 | logs/wp6-rollback-drill.log＋legacy-ae506fe-read-check.* |
| S4＝X08 切换半段 | 五段时序＋断言 A-E | 完成：编排脚本＋mock 上游＋fetch 守卫，23 断言 allPass，总耗时 31.8s；总指挥审计式复核（result.json 逐条＋mock 对账＋fetch 守卫＋双 worktree 终查） | logs/wp6-x08-switch-drill.log＋x08-result.json |
| S2 候选清单成文 | release-candidate.md 九章 | 完成（263 行）：候选标识/服务镜像/迁移说明/备份/切换单/回退单（§6 含 0095 守卫处理与期初门槛不恢复三条回退包要求）/已知边界/生产补核附录/状态声明；勘误 inv-wp6 三处（postgres:17 非 18、FEATURE 5 个非 7、rollback.sh 制品格式 -Fc vs .sql.gz 不通用） | release-candidate.md |
| S5 复验 | W20-10＋D-1~D-4＋6.4 | 完成：W20-10 3 样本（见 §3）；e2e 16/16＋定向 52/52＋CA 362/362；D-3/D-4 断言补齐（Resources.test.tsx +54 行 26/26）；strict valid＋typecheck 全 0＋lint 全 0（X07 测试 unused var 返工后） | logs/ 十份日志 |
| S6 生产补核 | 只读补核 | 命令清单已备（release-candidate.md §8，全只读）；仓库内无只读通道，**待用户主机执行回执**；未核实项如实记录 | release-candidate.md §8/§9 |

- 业务改动（本包新增，待提交见 §6）：`packages/database/src/__tests-integration__/wp6-rollback-drill.integration.test.ts`（新文件）；`apps/web/src/pages/Resources.test.tsx`（+54 行 D-3/D-4 断言，零触碰既有断言）；`V4/Evidence/.../WP4-20261104/screenshots/` 9 png＋1 txt（e2e 合规复跑原地重生成，同代码同内容含 D-2 渲染，采纳）。
- 文档改动：WP6 plan.md/notes/inv-wp6.md/release-candidate.md/report.md；matrix.md X07/X08 终态＋§5 更新行；tasks.md 6.3 勾选。
- 接口/配置变化：**零**（本包零业务代码改动）。

## 3. 验证记录（总指挥独立执行/复核为准）

| 验证 | 结果 |
|---|---|
| X07 回退演练（新增测试资产） | 7/7（S3 首轮＋总指挥复跑；返工后 7/7 复核）——down 链 0096→0092 八行集 sha256 逐字不变、0092 幂等重放、0095 守卫两态、0094 down 边界（新建资源重新 PENDING/存量不追溯）、回退后重升零丢失 |
| X07 旧代码（ae506fe）实证 | 三行式 PASS：准入（无 finance 行资源被旧候选**包含**；PENDING 行资源被**排除**＝如实边界）、可读（金额逐字＋OPENING_BALANCE_MISSING 口径差异不阻断）、可结算（旧写路径落新消费 0.00052000＋额度行可读） |
| X08 切换时序演练 | 23 断言 allPass（A 410+四表窗口零增量/B 在途收尾 drained+B4 金额 0.00040000/C worker 切换+官方刷新 runner+手动/D 开关周期新旧一致/E mock chat=3 balance=4 零外呼+fetch 守卫零 BLOCKED/X 跨栈金额一致） |
| W20-10 P95 复验 | **FAIL（3 样本：1426/1437/1468ms vs ≤1000；departmentBill 同红 1152/1250/1176）**——清理演练容器后无改善，本机负载定性维持；路径本包零触碰（业务改动仅 D-1~D-4 web/CA 透出）；不放宽阈值；CI/发布环境标定复验列发布前置（release-candidate.md §7.3） |
| D-1~D-4 受影响场景 | e2e wp4 spec 16/16（含 4 修复新断言）＋定向 52/52＋CA 全量 362/362（目标文件 2/2） |
| D-3/D-4 断言补齐 | Resources.test.tsx 26/26（新增 1 用例覆盖两文案） |
| 6.4 复核 | openspec strict valid；typecheck web/CA/database 全 0；lint 三包全 0（X07 测试 :487 unused var 返工删除后） |
| 红线终查 | 候选 worktree 零 tracked 业务代码改动（仅本包测试/断言/文档/证据）；旧 worktree status 干净零提交；0092-0096 迁移零触碰；主仓零写入；无真实付费/生产写入/部署/消息发送（X08 mock 计数＋fetch 守卫 fail-closed） |

## 4. 审核发现与缺陷处置

1. **X07 测试 unused var（本包自引入，已修复）**：S5 lint 发现 `wp6-rollback-drill.integration.test.ts:487` resourceId 未使用——退回原 S3 Agent 最小修复（解构去除，零断言语义变化），lint exit 0＋测试 7/7 复核。
2. **D-3/D-4 文案无自动断言（走查遗留缺口，已补齐）**：S1 证实 walkthrough 回执"组件测试覆盖"与代码现状不符——S5 在 Resources.test.tsx 补页面级断言（两文案各一），范围表预先登记。
3. **S2 勘误 inv-wp6 三处**（postgres:17、FEATURE 5 个、rollback.sh 制品格式）——按实际文件成文，备份制品格式统一列发布前置检查（release-candidate.md §4.2/§9-6）。
4. **总指挥口径裁定**：X08 断言 A"四表零增量"取"切换窗口内零增量＋T0 订阅登记为计划内基线"口径（订阅属 Coding Plan 保留路径 AFR-04），写入 release-candidate.md §7.2。
5. **e2e 复跑重生成 WP4 截图**（spec 副作用，9 png+1 txt）：同代码同内容且含 D-2 新渲染——采纳为新版本，记录在案。

## 5. 未解决/未核实项（移交用户/发布流程）

| # | 项 | 状态 | 影响 |
|---|---|---|---|
| ① | W20-10/departmentBill P95 本机 3 样本 FAIL（release-candidate.md §7.3） | 本机环境定性（WP5 §5-① 延续，劣化幅度如实） | 不影响功能正确性；**发布前置＝CI/标定环境复验**，不放宽阈值 |
| ② | 生产版本/迁移水位/开关补核 | **已闭合（2026-11-05 用户主机只读回执）**：三服务 4691a（cancelled-cost，2026-10-19，ae506fe 祖先）、worker f27cb50（PR #7 Worker 修正上线证实）、水位 0091（0092 未执行→发布实跑 0092-0096 五个）、资金模式默认 ACTIVE（代码默认已核实）、FEATURE 五开关全 false、无 backups 目录（发布前必须建）——详见 release-candidate.md §8.1 | 候选对生产纯前进无分叉；WP0 遗留三项全闭合 |
| ③ | 备份制品格式统一（-Fc vs .sql.gz）＋rollback.sh 期望头 0045→按备份点定制 | 发布前置检查项（未裁定） | 发布实施时落实，非本包缺陷 |
| ④ | 走查遗留服务 5173/8788 未停（用户进程，本包避让） | 待用户处置 | 不阻塞 |
| ⑤ | 全量 e2e wt-web 合成上游基建（WP5 §5-② 延续） | 环境型缺口 | 建议单独立项；不阻塞本包 |
| ⑥ | 官方余额端点硬编码（provider-operating-facts.ts:30，S4 发现） | 已知边界记录（零改码） | 如需代理/换端点另行评估，非本 change 范围 |
| ⑦ | 旧基线 worktree `/Users/mac/Projects/仟流智算-wp6-legacy-ae506fe` 保留 | 待用户处置（复现 X07 旧代码实证的前提） | 可留可删，删除不影响已归档证据 |

## 6. 本包结论

**通过**。task 6.3 退出条件逐项：具体发布/回退清单 ✓（release-candidate.md 九章）；切换后无资金账户新 API 消费回退兼容演练 ✓（X07：数据逐字保留/可结算/受额度约束/不补期初/旧代码实证含边界）；旧资金要求不在回退时恢复为调用门槛 ✓（操作单 §6.4：回退期间新建资源冻结＋前滚优先＋零补期初；旧代码对无 finance 行资源本就放行）；0095 down 守卫处理 ✓（多行拒绝→只能主路线，不删数据）；隔离环境演练 ✓（X08 23 断言＋X07 7/7＋独立复跑/审计复核）。**矩阵累计 PASS 50/50**。未执行：生产部署/迁移/发布（本包计划与演练不构成授权）；生产补核待回执（§5-②）；W20-10 CI 环境复验待发布流程（§5-①）。

## 7. 提交记录

- 业务提交：X07 测试资产＋D-3/D-4 断言＋截图重生成（见 git log `feat(acceptance): add WP6 rollback drill and D-3/D-4 assertions`）。
- 文档提交：WP6 全套文档＋矩阵终态＋tasks.md 6.3 勾选（`docs(openspec): close WP6 with release candidate and switch/rollback drills`）。

## 8. 后续（change 收尾）

- 21 项 tasks 全部勾选；三份 spec 场景 42＋8 回归全部执行留证。**archive/apply 前提**：生产部署获授权并执行、生产补核回执、W20-10 CI 复验、发布签收——按 tasks.md Workflow follow-up 另行安排，本轮不 archive。
- 新任务启动指令（若需发布实施包）：读取同款总指挥指令，当前工作包改为「发布实施（用户授权后）」，上一包交接记录改为 `handoff/work-packages/WP6/report.md`。
