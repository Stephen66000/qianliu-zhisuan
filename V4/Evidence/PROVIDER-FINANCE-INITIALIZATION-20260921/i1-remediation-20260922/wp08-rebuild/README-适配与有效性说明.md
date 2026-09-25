# WP08 候选镜像重建与 PFA-08/09 演练复跑 —— 适配与有效性说明

> 本目录是 I1 整改（F-P1-7「rebase 到 kimi 已修 tip 后，WP08 候选镜像作废重建」）的证据。
> 所有动作仅作用于**本地一次性容器库 / 本机 Docker**；未推送任何 registry（`RepoDigests=[]`），
> 未部署、未激活生产、未访问真实厂商上游（仅本地桩 `127.0.0.1:9299`）。
> 新候选 commit：`94482f06e5ac69a80357b6e17b9786f7690265c4`（tree `fb1212dba139…`）。

## 1. 与冻结原件的差异清单（逐项可核）

| 文件 | 是否改动 | 改动内容 |
| --- | --- | --- |
| `image-digests.sh` | 已适配 | **仅**候选 commit/tree/索引摘要与镜像标签由 `c9bc9b93deb2` 改为 `94482f06e5ac…`；采集项与参数含义逐项未变（文件头已注明） |
| `dual-dark-drill.sh` | 已适配 | 见 §3（3 处，均为**证据保真**与**就绪确定性**，未放宽任何断言） |
| `quiescence-drill.sh` | 已适配 | 仅第 88 行池位 `P1 P2 P3 P4` → `P1 P2 P3 P4 P5 P6`（见 §4） |
| `quiescence-seed.ts` | **未改动** | md5 与 `wp08-scripts/quiescence-seed.ts` 一致（`79b2071fba9061742ce5984b8b9c874a`） |
| `worker-renewal-fixture.ts` | **未改动** | md5 与 `wp08-scripts/worker-renewal-fixture.ts` 一致（`cd69e8449354c9099441f27685b2518a`） |

新增的**辅助**脚本（冻结原件中没有，故无"原样性"可比）：

- `refresh-sessions-all.ts`：批量重签 PFA-08/PFA-09 所需的全部管理员会话（见 §2）。
- `seed-extra-pool.ts`：按 `quiescence-seed.ts` 同一列集合追加 pristine 池位 P5/P6（见 §4）。

> **入库口径**：仓库 `.gitignore` 含 `*.log`，故本目录的日志需以 `git add -f` **强制入库**。
> 这与本证据目录的既有惯例一致（`wp06-logs/`、`wp07-logs/` 下的 `.log` 均为强制跟踪）。
> 另请注意：**冻结的 `wp08-logs/` 下 11 个文件仅 `8.1-compose-resolved.yaml` 被跟踪**，
> 其余 10 个 `.log`（含 `8.2-dual-dark.log`、`8.3-quiescence.log` 原件）处于 ignored 状态、
> **未进入 git** —— 属冻结交付件的证据完整性缺口，本轮不擅自改动冻结件，仅在此登记，请复审方一并裁决。

## 2. 会话有效性：本目录所有演练结论的前置条件

`secrets.json` / `quiescence-secrets.json` 里的会话 Cookie 由播种脚本以 **8 小时 TTL** 签发。
**重用同一批本地容器库重跑时旧 Cookie 已过期**，会以两种方式产生错误结论：

- **假绿（PFA-08）**：写入口先被鉴权层 `401` 挡下，响应体**不含**门禁串「资金写入口尚未启用」，
  drill 的 `classify()` 只认门禁串，于是判为 `PASSED(未拦)` —— 与断言预期恰好一致，**看起来通过**。
- **大面积假红（PFA-09）**：控制面写入探针整体 `401`，断言成片 FAIL。

`refresh-session.ts`（单管理员）与 `refresh-sessions-all.ts`（PFA-08 单管理员 + PFA-09 全部 10 个租户）
只做一件事：各插入一条新的 `admin_session` 行并把新令牌写回对应机密文件；**不触碰** provider /
resource / principal / 资金事实链路。重签回执见 `8.2a-refresh-session.log`。

> 凭证文件位于 `/tmp/wp08/`，**不进入证据归档**。

## 3. `dual-dark-drill.sh` 的 3 处适配

1. **证据展示串改号**（第 98 行）：`同一候选 commit c9bc9b93deb2` → `94482f06e5ac`。
   不改则日志正文会声称错误的候选 commit —— 属证据保真缺陷。
2. **就绪轮询替代盲目 `sleep`**：新增 `wait_mode()`，在 `--force-recreate` 后轮询读接口，
   并要求响应体的 `mode` 字段等于期望值（既证端口可达，又证是**新模式的新容器**在服务）。
   原脚本用固定 `sleep 6`，会撞上「Docker 端口代理已指向新容器、应用尚未 listen」的窗口，
   探针得到 curl `000`（连接失败）→ 被 `classify()` 误判为 `PASSED(未拦)`，**B 阶段假绿**。
   实测该窗口存在（见 `8.2-dual-dark.INVALID-1-端口代理竞态.log`），就绪耗时约 3~9 秒。
3. **前置阶段 0**：开跑前强制把基线置为 `ACTIVE` 并等待就绪，使演练**可重复且自证基线**。
   原脚本假定入口态为 ACTIVE；若上一次操作把栈留在 DARK，A 阶段基线会整体失效
   （见 `8.2-dual-dark.INVALID-2-基线非ACTIVE且D阶段竞态.log`）。

**未放宽任何断言**：B 阶段仍要求 8 个写入口响应体命中门禁串、读接口不得命中门禁串、
事实与 `strict_writes_enabled` 逐字节不变；C 阶段预检前后快照须逐行一致。

## 4. `quiescence-drill.sh` 的 1 处适配与池位说明

第 9 节需要在**未被任何资金写入触碰过**的企业上做一次性正向激活（严格写激活不可逆）。
原冻结池 `P1..P4` 已用尽（P1/P2/P3 已激活，P4 在本轮一次无效运行中留下合成订阅夹具）。

`provider_finance_event` 是 **append-only**（触发器 `provider_finance_reject_event_mutation`
拒绝 DELETE），因此**无法**通过删除复原 P4，也**不应**临时禁用完整性触发器来绕开。
故由 `seed-extra-pool.ts` 追加 pristine 的 P5/P6，并把池位扩到 P6。

**实测结论：本次 PFA-09 的池位仍选中 P4**（P4 无 `provider_finance_runtime_state` 行，
在 `P1..P6` 顺序中先于 P5），且 **PASS=105 / FAIL=0** —— 说明那条前置的合成
`CODING_PLAN_PURCHASE` 事件既未使激活预检从 `GO_CANDIDATE` 退化，也未使回执守恒检查失败。
P5/P6 属**冗余保险**，保留以使演练可持续重复（下次将自动选中 P5）。

## 5. 无效运行留档（不计入结论）

| 文件 | 失效原因 | 处理 |
| --- | --- | --- |
| `8.2-dual-dark.INVALID-1-端口代理竞态.log` | B 阶段 `--force-recreate` 后固定 `sleep 6` 不足，8 个写入口返回 curl `000` 被误判为「未拦」 | 已加 `wait_mode()` 就绪轮询后重跑 |
| `8.2-dual-dark.INVALID-2-基线非ACTIVE且D阶段竞态.log` | 入口态为 DARK（前一操作遗留），A 阶段基线失效；D 阶段再现 `000` 竞态 | 已加前置阶段 0 + `wait_mode()` 后重跑 |
| `8.3-quiescence.INVALID-1-租户会话过期.log` | 租户 Cookie 过期，控制面写入探针整体 `401`，`PASS=28 / FAIL=77` | 已 `refresh-sessions-all.ts` 重签后重跑 |

其中 `8.3` 的无效运行还留下了合成副作用，已按 §6 处置。

## 6. 状态污染与本轮自我更正（诚实登记）

本轮会话在诊断过程中制造了以下状态，均已处置并留证：

1. **P4 合成订阅夹具**（无效 PFA-09 第 10 节写入：1 条 `CODING_PLAN_PURCHASE`、1 条幂等键、
   1 条订阅期、1 条 `provider_resource`、1 条 `provider`）。因事件表 append-only，**未删除**该事件；
   其余已在 `8.3a-p4-baseline-restore.log` 中按自上而下解引用顺序删除。该事件对 PFA-09 结论
   **无影响**（§4 实测）。
2. **P4 预检实验**产生的一条 `PREVIEWED` 候选与一条租约：租约已通过 release 端点显式释放
   （`RELEASED`），并已用 `listQuiescentEnterpriseIds` 复核门禁列表为 `[]`。
3. **PFA-08 的写入口探针对 `activation-quiescence` 的 POST 会真实创建租约**（返回 201）——
   这是原冻结演练固有的副作用，非本轮引入；PFA-09 第 0 节会先行释放。

## 7. 结论

| 演练 | 日志 | 结果 |
| --- | --- | --- |
| PFA-08 双端停写 | `8.2-dual-dark.log` | **通过**：B 阶段 8/8 写入口 `404 BLOCKED(暗门禁)`；读接口全部按合同保留；`fact_fingerprint` A→B→C→D 恒为 `bef0edc66e642f6eba58c0912b8f8649`；C 阶段预检只读（快照逐行一致） |
| PFA-09 激活前静默 | `8.3-quiescence.log` | **通过**：`PASS=105 / FAIL=0`，`RESULT: GO`；零上游、在途排空、租约 60 分钟上限、剩余 ≥5 分钟、候选 TTL 30 分钟、到期自动恢复、旧候选拒绝、正向激活 + 幂等重放全绿 |

镜像身份：4 个候选镜像 `qianliu-candidate/*:94482f06e5ac`，`org.opencontainers.image.revision`
均为 `94482f06e5ac69a80357b6e17b9786f7690265c4`，`RepoDigests=[]`（未推送）；
容器端口全部绑定 `127.0.0.1`。
