# 运行保障与管理员发布准备：有限独立审查

**结论：PASS（限定为发布脚本、演练证据及此次集成保留检查）。发现的 1 个 P2 查询退出码问题已修复并关闭，当前无未关闭 Finding。没有在 Mac mini 或生产服务器执行部署。**

## 1. 本轮范围和精确对象

Reviewer：`/root/i1_runtime_admin_review`，未参与源码或脚本修改。审查时间：2026-09-08 09:59–10:16（Asia/Shanghai）。工作树为 `/Users/mac/.codex/worktrees/runtime-admin-integration-20260908/仟流智算`。

本轮读取和审查：

- `deploy/scripts/release-runtime-admin-20260908-mac-mini.sh` 全文及本轮修复；
- `scripts/rehearse-runtime-admin-release.mjs` 全文及新增失败场景；
- 真实 PG17 备份/恢复与迁移演练源码及其结果；
- feca860 已部署增量在最终候选中的保留；
- 主会话追加指定的两处财务旧快照断言与 Resources 按钮定位适配；
- 对应已有测试日志和最终 verification.json，不重新执行全量或 V1.4 全套门禁。

| 对象 | 最终绑定 |
| --- | --- |
| 目标应用 commit | `0bf4c1c0a17afc3a4a380f92958297efd46026b6` |
| 目标应用 tree | `468182ad84d860aa73b0b71968bfe0453410c4c2` |
| 来源 commit / tree | `feca8603210bcc109346faf03860bfea50d61742` / `82d1a4f1553fc362eecaaf18dfbf4c38348687c6` |
| 来源 / 目标迁移 | `0066_subscription_auto_renewal` → `0068_alert_resource_context` |
| 发布脚本 SHA-256 | `f53db4afe227532d79a1af561997b9e9f4582d8eb87db0528b70dcbae42eb8e5` |
| 演练器 SHA-256 | `7b3bc59278a841e3975778400a324939e31a007b463238f51e5946db6e3b0f0b` |

初始占位 candidate/tree 已由主会话按计划替换，最终脚本与本地 commit/tree 均匹配。脚本和演练器在审查时尚未提交，后续工具包提交应保留上述内容哈希；应用代码继续绑定 0bf4c1c，不能将工具包提交误作运行应用版本。

来源依据是另一工作树 `AUGUST-OVERVIEW-RELEASE-20260907/production-receipt.json` 的用户 COMPLETE 回执。已核对其中 commit/tree/migration 与 git 对象一致；没有 SSH 读取生产当前状态。脚本在真实运行时必须重新核对来源，出现不同来源就停止并回传，不猜测服务器状态。

## 2. 关键发布路径判断

### 精确来源与迁移范围：PASS

默认模式为 `--preflight`。先检查发布指针路径及物理路径一致性、来源 HEAD/tree、工作区干净、Compose 配置、完整数据库迁移集合、业务容器 working_dir/镜像匹配和健康状态，再允许显式 `--deploy`。

部署使用 SSH 443 拉取固定 candidate，校验 HEAD/tree 与 feca860 祖先关系。已用本地 git 独立核对 feca860 是 0bf4c1c 的祖先，迁移 diff 精确为两个新增文件：

```text
A packages/database/migrations/0067_admin_cleanup.js
A packages/database/migrations/0068_alert_resource_context.js
```

脚本还固定校验两个迁移内容 SHA-256，禁止改动来源已有迁移，以及受保护的 Compose、Caddy、Postgres 初始化、依赖清单与锁文件。当前目标与 feca860 在这些配置路径上无差异。GitHub 可达性在 fetch 阶段验证，该阶段位于停业务服务之前。

### 停写与备份：PASS（脚本控制及本地证据范围）

流程顺序清楚：冻结旧应用镜像 → 构建新镜像 → 再查来源 HEAD/干净状态/配置哈希 → 设置 started → 停 caddy/web/gateway/control-api/worker 并逐容器确认不运行 → 复核迁移集合 → pg_dump → 非空及 pg_restore 目录校验 → 计算备份 SHA → 执行迁移。

Postgres 保持运行以完成备份；业务入口、API、Gateway 与 Worker 被停止。脚本没有自动 drop/down/整库恢复，也不覆盖已有 release 目录；新目录使用 mktemp，环境文件只复制并比较哈希，未打印密码或密钥内容。备份和日志路径与发布指针分开保留。

### 归档与失败恢复：PASS

`safe_previous` 只接受来源迁移集合、来源加 0067，或来源加 0067/0068；未知集合或查询失败一律拒绝旧应用恢复。若 0067 已存在，必须成功查询归档数并确认是 0。归档管理员存在时不会重新启动忽略 archived_at 的旧代码。

失败恢复先再次停服并确认，再判断数据库状态；可以安全恢复时重绑冻结的旧镜像、以旧 release 和 `--no-build --no-deps` 重建服务，复核容器及健康后恢复指针。无法确认安全、存在归档身份或出现未知迁移时，保持服务停止、保留备份与发布锁，要求向前修复。成功路径在目标迁移、健康和 restart count 检查后才原子更新发布指针。

`--preflight` 分支在创建锁、目录、备份、构建或迁移之前退出；`--check-contract` 明确只输出 shell 语法检查结果，没有冒充实际部署验收。

## 3. 本轮 Finding 与关闭证据

### R-01 · P2 · 数据库迁移查询退出码被外层 test 丢弃：CLOSED

原脚本五处采用 `test "$(db_names)" = expected`。Reviewer 用不连接数据库的最小 Bash 实验确认：函数打印正确列表后 return 1，外层 test 仍可返回 0，从而把失败查询误记为已核验。

主会话已增加 `require_db_names()`，先执行 `actual_names="$(db_names)" || return 1`，成功后才比较完整集合；五处主流程检查全部替换。`safe_previous` 的 names 与 archived_count 也显式传播查询失败。

Reviewer 从当前脚本提取真实 helper 独立验证：相同 stdout 下，query exit 0 → helper exit 0；query exit 1 → helper exit 1，且没有打印后续 ACCEPTED。新增最终 mock 场景又验证：

- `history-query-fail`：输出正确迁移列表但退出失败，预检 exit 2，events 为空；
- `post-migration-query-fail`：迁移后查询失败，exit 1，服务停止、锁保留、无 restore-old；
- `archive-query-fail`：归档查询输出 0 但退出失败，同样不恢复旧应用。

没有剩余需要修改脚本才能关闭的 Finding。Reviewer 没有自行修复源文件。

## 4. mock 与真实 PG 演练证据

### 最终 mock：20 场景 PASS

已完整阅读演练器实现，并读取 [script-rehearsal-final.json](./script-rehearsal-final.json) 及每个临时场景的 state/release.sh。20 个场景均 PASS，且把各场景唯一的临时 root 还原后，**20 份实际执行脚本全部与当前 f53db4af… 脚本逐字一致**，候选均为 0bf4c1c/tree468182ad…。

演练器使用临时目录和 git/docker/curl/sleep doubles；真实部署状态不被触及。覆盖来源/脏工作区/锁/迁移集合拒绝、目标 tree/迁移差异拒绝、构建/备份/停止/迁移/启动/健康失败、未知迁移、归档保护、查询失败以及成功。事件顺序验证 stop < backup < backup-validate < migrate < start-new，成功后才更新指针。

最终需保留锁且不启动旧应用的场景，在 state 中均确认为 running=false、lockRetained=true、restoredOld=false。preflight 为 exit 0、无事件、不创建锁。

这证明脚本的被模拟控制流程；mock 使用整体 running 布尔和固定镜像/健康响应，不能等同于真实 Docker 信号传递、逐容器混合状态、真实网络/磁盘故障或服务器恢复演练。`stop-partial` 具体模拟的是停止命令首次失败后的处置分支。早期 script-rehearsal.json 对应未最终绑定的版本，不用于最终脚本结论。

### 真实 PG17：已有执行结果已核查

已读 `runtime-admin-release-rehearsal.integration.test.ts` 全文与 [pg-rehearsal.log](./pg-rehearsal.log)：真实 PostgreSQL 17 临时容器从 0066 起步，执行 pg_dump、pg_restore -l、恢复至另一临时数据库，再验证迁移至 0067/0068、principal_accounting_assignment.created_by 保留、管理员归档后拒绝回退。测试通过。

这验证了临时 PG17 的备份可恢复和迁移/历史约束；生产发布脚本本身没有自动执行整库恢复。该 PG 用例由主会话执行，本 Reviewer 本轮没有重新启动数据库或全量测试，更没有在 Mac mini 执行。

## 5. feca860 保留和追加测试修订

对 99d4f99→feca860 的 67 个已部署增量路径逐项对照：生产侧仅 index.ts 与集成候选不同，且 feca860 的公开命名导出无缺失。其他该增量生产文件保留；唯一变化的既有测试是订阅自动续费迁移测试的后续迁移顺序适配。0066_subscription_auto_renewal 未被覆盖，运行保障迁移顺延为 0067/0068。

407d682→最终 0bf4c1c 只有 Resources.test.tsx 的 5 行新增/5 行删除，均为两个测试标题及三个按钮定位从“充值”对齐到已部署的“充值／订阅”；生产文件没有变化，入账禁用和 payload 断言保留。

另两处追加旧快照修复与 feca860 的现有实现一致：

- provider-finance-cutover：fixture 既有 199 元 PACKAGE_PURCHASE 被 registeredSubscriptionHistory 纳入当月套餐成本，API 经营成本仍精确为 5 元；明确断言 codingPlanFixedCostCny=199、总成本=204，未放宽为任意值。
- operating-bill-account-aggregate：既有生产返回 knownApiCost，新期望补充精确的 1.2 和 2；仍使用完整 toEqual，原 null/UNKNOWN、Token、总额等断言保留。

[repaired-regressions.log](./repaired-regressions.log) 显示上述两文件加 PG 演练共 23 项通过。

## 6. 最终验证集合和声明边界

已读取主会话 [verification.json](./verification.json)，并独立核对所列 12 份日志 SHA-256，全部匹配；分包用例数合计 1786。已有原始日志证据显示最终 database 66 文件/392 项、Web 58 文件/279 项、Control API 43 文件/287 项、Gateway 41 文件/315 项、Worker 10 文件/33 项通过。

验证集合的准确表述是：原分包全量运行，加旧断言修复后的 Database 与 Web 完整分包重跑，汇总 247 文件/1786 项；原数据库 3 个失败与旧 Web 2 个失败日志仍保留。它不是把失败的首轮日志覆盖成一次性全绿，也不是 Reviewer 独立重跑了整个集合。

本 Reviewer 实际另行执行了当前 shell `bash -n`、演练器 `node --check`、git 祖先/迁移/配置/保留检查、最终脚本与所有 mock 副本的同一性检查，以及 R-01 的独立 Bash 故障传播实验；全部满足本轮有限审查目的。

**发布准备有限审查 PASS；服务器执行为 NOT_EXECUTED。** 下一步由主会话按用户已授权范围提交/推送工具包及精确应用候选，用户在 Mac mini 先运行默认只读预检，核对真实来源后再显式部署。GitHub 可达性、真实 Mac mini 预检/停写/备份/升级/健康回执和页面验收，只能在相应实际动作完成后另行记录。
