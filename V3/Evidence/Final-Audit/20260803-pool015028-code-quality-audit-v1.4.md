# POOL-015～028 代码质量审计报告（v1.4）

## 0. 审核元数据

- `audit_id`：`CQA-20260803-POOL015028-R1`
- `project / stage`：仟流智算 / POOL-015～028 上线候选
- `audit_round`：1
- `contract_ref`：Owner 指令“按 v1.4 审核，通过后部署至 192.168.1.40”
- `risk_level`：R3（认证、密钥、计费账本、数据库迁移、生产发布）
- `required_independence`：I2
- `actual_independence`：I2
- `independence_evidence_ref`：主审 GPT-5.6 完成机械门禁与语义复核；未参与作者链的 Kimi 通过仟流 Gateway + Codex CLI 只读沙箱独立复核完整候选并给出 PASS
- `reviewer_identity / model_or_verifier`：GPT-5.6 主审；Kimi 独立 Reviewer
- `coding_standard`：`AI编码工程规范-通用版-v1.4.md`
- `audit_template`：`AI代码质量审计模板-通用版-v1.4.md`
- `functional_audit_decision`：本地功能证据 PASS；POOL-027/028 的真实厂商及 WorkBuddy/Codex/Z Code 业务验收保留到发布后
- `evidence_mode`：local-first
- `base`：`7b0235fa6868c00bde1e2621299f1d338aec07a5`
- `reviewed_head_or_candidate`：上述基线到当前工作区的 POOL-015～028 候选
- `candidate_manifest`：`V3/Evidence/Final-Audit/20260803-pool015028-code-quality-candidate-lock.sha256`
- `candidate_manifest_sha256`：`1cd8157b0fc943f146ae683802d2094d5b638225b52ccb83d37619967dfc7be8`
- `complete_diff_or_path_set`：145 个生产、测试、迁移、配置及 Evidence 文件；知识库、状态账本和机械报告不进入实现对象锁
- `quality_gate_config`：`V3/仟流智算-质量门禁-v1.0.json`
- `quality_gate_tools_and_versions`：Node `22.17.1`；pnpm `11.11.0`；TypeScript；ESLint；Vitest；Playwright Chromium；Stryker；jscpd；pnpm audit/licenses
- `start_lock_verification`：145/145 OK，STABLE
- `end_lock_verification`：145/145 OK，STABLE
- `decision`：PASS

## 1. Audit Contract

- 审核对象：POOL-015～028 全部新增和修改的实现、测试、迁移、配置与直接上下游。
- 审核边界：不提交、不推送；审计通过后按 Owner 授权执行 Mac Mini 备份、发布、迁移和冒烟。
- 审核原则：机械门禁只作证据，不替代完整 diff、关键路径、事务、安全和失败语义阅读。
- 对象锁：主审和独立 Reviewer 均在首尾执行逐文件 SHA-256 核验，未发现对象漂移。

## 2. V1.4 代码阅读矩阵

| 检查域 | 结果 | 主要证据 |
|---|---|---|
| 结构与职责 | PASS | Provider 路由/合同/发现、Gateway 计费、数据库类型/仓储、Web 组件已按层拆分；180 个生产源文件通过体量门禁 |
| 状态与资源生命周期 | PASS | 数据库事务、PG 行锁/咨询锁、AbortController timer 清理、Worker DB/HTTP Server finally 清理、流式失败 fail-closed |
| 依赖与架构边界 | PASS | domain、adapter、database、transport 分层；架构扫描 180 文件、无运行时环；外部输入均在路由边界验证 |
| 配置与安全 | PASS | 密钥加密及指纹化；凭证明文不返回、不入日志；管理员/企业隔离；发布 Manifest 敏感字段与本机路径拒绝 |
| 类型、数据与错误 | PASS（登记 P2） | 无 `as any`、`@ts-ignore`；关键错误有稳定状态码；JSONB 冻结快照读取和 JSONB 插入类型断言登记为后续类型加固 |
| 注释与可读性 | PASS | 高风险事务、幂等、计费冻结、客户端身份可信度均有 why/边界说明；无敏感注释 |
| 测试语义 | PASS | bug 回归、跨租户、并发幂等、边界、迁移、流失败、真实 Web 和 Codex 工具调用均有断言；未放宽门禁或删除断言 |

## 3. 风险分级质量门禁

| gate | 项目阈值 / 基线 | 结果 | Evidence |
|---|---|---|---|
| lint / typecheck | R3 必须 | PASS | Node 22.17.1 下 `pnpm quality` |
| unit / integration | R3 必须 | PASS | workspace 全套测试；关键 POOL-025/027 集成回归通过 |
| build / package | R3 必须 | PASS | 全 workspace 生产构建通过 |
| coverage + ratchet | 项目配置 | PASS | Control API 100/94.44；Worker 100/96；Domain 97.53/90.92；Observability 100/88.88；Provider Adapter 100/87.5（语句/分支） |
| complexity / source size | 默认复杂度 30；生产源文件默认 ≤400 逻辑行 | PASS | 冻结例外未增长；180 个生产源文件通过 |
| duplication | ≤5% | PASS | 0.75% 行、0.57% token |
| architecture | 无运行时环和越界 | PASS | 180 文件，无 runtime cycle |
| incremental mutation | break 70，target 80 | PASS | Domain 88.29%（641 killed / 72 survived / 13 no coverage）；Worker 100%；disposition gate PASS |
| vulnerability | 无未批准中高危 | PASS with exception | 1 个已登记 React Router RSC-only 高危例外，当前项目不使用 RSC，失效日 2026-09-01 |
| licenses | 项目白名单 | PASS | Apache-2.0、BSD-3-Clause、BlueOak、ISC、MIT、Unlicense |
| Web E2E | Chromium | PASS | 25/25 |
| 官方 Codex 客户端 | 流式 + 工具 + Usage/账本 | PASS | `codex-cli 0.146.0-alpha.9.2` exit 0；两轮工具调用；input/output/cache/reasoning 与账本一致 |
| I2 独立代码阅读 | R3 最低 I2 | PASS | Kimi 只读审计：P0=0、P1=0、对象锁首尾 145/145 OK |

说明：一次使用错误 Node 24 运行的辅助全量测试出现单个 60 秒超时；该结果不作为正式 Evidence。随后目标运行时 Node 22.17.1 的正式门禁完整通过，Gateway 全套测试亦独立通过。

## 4. Evidence 真实性与综合判断

- 所有 PASS 均来自本轮真实命令、报告和代码阅读；未运行项没有写成 PASS。
- 独立 Reviewer 未修改工作区，且未直接采信主审摘要；自行读取规范、候选 diff、迁移、核心安全/事务/计费路径和关键测试。
- 本地 E2E 使用临时 PostgreSQL，执行后已删除临时容器；未触碰生产数据库。
- 对象锁首尾一致；报告和机械输出不属于实现锁，因此生成本报告不构成候选漂移。
- 正式厂商联网与三端业务验收必须在部署后用真实凭证执行，本审计不把它们伪装成本地已完成。

## 5. Findings 与处置

| ID | priority | location | issue / impact | Owner | 缓解与退出条件 |
|---|---|---|---|---|---|
| CQA-P2-01 | P2 | `apps/web/src/assets/qianliu-logo-primary.png` | 图片约 789 KB、白底 RGB，存在首屏体积和深色主题风险 | Web | 当前构建及 E2E 正常；下个 UI 发布前换成透明压缩资源，并以 bundle/明暗主题截图退出 |
| CQA-P2-02 | P2 | `apps/web/src/components/operating-bill/`、`design/` | 存在未被生产页面引用的原型组件/设计资产，增加仓库噪音但不会进入 bundle | Web / Product | 生产页面无 import；2026-08-15 前确认归档或删除，以 `rg` 无生产引用和构建通过退出 |
| CQA-P2-03 | P2 | `packages/database/src/repositories/operating-bill-repository.ts:51` | 已冻结 JSONB 快照读取使用类型断言，损坏数据缺少明确 fail-closed 校验 | Backend | 写入路径有强类型且结账集成测试通过；下个 POOL-025 加固批次增加运行时 schema 与 `snapshot_corrupt` 回归测试 |
| CQA-P2-04 | P2 | `packages/database/src/repositories/deployment-log-repository.ts:60` | JSONB 数组通过反向类型断言适配 pg 驱动，运行正确但类型表达误导 | Database | 集成测试覆盖导入/幂等/不可变；下个数据库类型清理批次使用准确 `ColumnType`，以无双重断言退出 |
| CQA-P3-01 | P3 | `apps/worker/src/main.ts:163` | 运行保障与供给预测同 tick 串行，一个失败会跳过本轮另一个任务 | Worker | Scheduler 后续轮次会继续；下一 Worker 可靠性批次拆分错误边界并增加单任务失败不影响另一任务测试 |
| CQA-P3-02 | P3 | `packages/domain/src/client-identity.ts:48` | `x-client-id` 是客户端声明事实，经营页面需要持续提示其非鉴权证据 | Product / Web | 已冻结 source/confidence 且不参与鉴权/计费；三端验收时确认弱可信标识，以页面展示来源和可信度退出 |

独立 Reviewer 的“事务级套餐费用由 NULL 改为 0”不成立：`ledger_transaction.total_api_cost` 自迁移 0009 起为非空字段，基线也写入 `0`；仅 `ledger_line.api_cost` 保持套餐模式 `NULL`。该项不计 Finding。

- `finding_freeze_complete`：是
- `p0_count / p1_count / p2_count / p3_count`：0 / 0 / 4 / 2
- `evidence_gap_count`：0（代码质量）；发布后业务验收项单独保留
- `scope_conflicts`：无

## 6. Decision

**PASS**。

通过依据：R3 全部适用门禁通过；I2 独立性满足；P0/P1 与阻断性 Evidence Gap 均为 0；P2/P3 已登记 Owner、缓解、复核时间和退出条件；候选对象锁首尾 STABLE。

下一动作：只允许按已授权流程执行 Mac Mini 数据库备份、候选包上传、停流迁移 `0033`～`0037`、同批启动、健康检查和只读业务冒烟。任一步失败立即停止并按备份/旧 release 回滚；禁止推送、创建 PR 或扩大生产验证范围。
