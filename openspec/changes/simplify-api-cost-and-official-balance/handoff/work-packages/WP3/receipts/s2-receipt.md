# WP3 S2 回执：runner 解耦＋周期门禁＋迁移 0095（task 3.1）

实施：glm-flash（S1 同会话）；日期：2026-11-03；基线 HEAD `67c9aec`（含 S1 笔记，开工时工作树仅有 S1 notes/plan 未跟踪文件）。

## 1. 实际改动文件清单

| 文件 | 改动 |
|---|---|
| `packages/config/src/index.ts` | 新增三个读取器：`readProviderOperatingSyncIntervalMs`（P1，env `PROVIDER_OPERATING_SYNC_INTERVAL_MS`，默认 900000ms）、`readProviderOperatingBalanceExpireMs`（P2，`PROVIDER_OPERATING_BALANCE_EXPIRE_MS`，默认 1800000ms）、`readProviderOperatingBalanceRefreshCooldownMs`（P3，`PROVIDER_OPERATING_BALANCE_REFRESH_COOLDOWN_MS`，默认 30000ms）。全部经 `readPositiveIntEnv`（fail-fast，错误信息含变量名＋"毫秒"），注释标明"建议默认值，可配置；P1 按厂商限制可调（DeepSeek 限流未核实）"。P2/P3 本阶段只建齐不消费（裁定 B） |
| `packages/config/src/__tests__/config.test.ts` | 新 describe 3 用例：默认值/显式覆盖/非法值（含变量名与单位断言） |
| `apps/worker/src/provider-operating-sync/runner.ts` | 解耦重写（详见 §2）；`ProviderOperatingSyncResult.skipped` 字段删除；新增 `shouldSkipUntilNextSync`（next_sync_at 周期门禁）与 `inheritCostFacts`（自原 :218-219 三元链提取，语义逐字保留——为满足 lint complexity≤30，纯搬移） |
| `apps/worker/src/provider-operating-sync/runner.test.ts` | 全量改写为 3 用例（§4） |
| `apps/worker/src/__tests-integration__/provider-finance-quiescence-worker.integration.test.ts` | 仅时间推进适配：静默用例第 2/3 次 tick 的 `now` 推进 16/32 分钟越过 P1 窗口（原同刻 tick 在新门禁下会被 next_sync_at 跳过，导致 `resourcesScanned = baseline - skipped` 断言失配）；静默语义断言零改动 |
| `packages/database/migrations/0095_official_balance_sync_decouple.js` | 新建：up 仅 `DROP INDEX provider_resource_operating_sync_attempt_daily_uq`；down 先查同键多行（`GROUP BY ... HAVING count(*)>1`），存在则抛错拒绝（错误信息含"0095 down"），否则按 0051 原列重建唯一索引 |
| `packages/database/src/__tests-integration__/wp3-operating-sync-decouple.integration.test.ts` | 新建 3 用例（§4） |

未触碰：subscription-renewal/runner.ts（fail-closed 保留，其测试 3/3 全量绿）、control-api（server.ts mode 门控等）、main.ts（core 槽位 :333-336 原样，`skipped` 字段无消费者）、0026/0051/0092/0093/0094 本体、resource-pool-repository.ts（:252-273/:443/:451 零改动）、web/预测/insights（S4/S5 范围）。

## 2. runner 新旧行为对照

| 维度 | 旧（HEAD 67c9aec） | 新（本阶段） |
|---|---|---|
| 资金门禁 | `readProviderFinanceMode ≠ ACTIVE` → 整 tick skip（`FINANCE_MODE_INACTIVE`，零写入零上游） | 已删除；DARK/OFF 下照常同步落快照/attempt（OAB-03 场景 1，测试钉死） |
| 频率门禁 | attempt 表存在当日行则 skip；充值流水（API_RECHARGE）晚于最近 PROVIDER_SYNC 快照时当日补同步一次 | `next_sync_at > now` 则 skip；`next_sync_at = now + P1`（env 可配，默认 15min）；充值依赖（`needsPostRechargeSync`，resource_purchase_record 查询）整段删除（WP2 后充值写入口 410） |
| attempt 同日多行 | `daily_uq` 唯一索引＋insert `onConflict doNothing` 吞掉 | 0095 drop daily_uq＋insert 去掉 onConflict：同日每次尝试各留一行（旧行全保留） |
| 恢复链 | `recoverFromFreshPositiveBalance`（:89-101）/`recoverFromFetchedBalance`（:103-109）→ `recordBalanceSyncRecovery` | **零改动**，且恢复尝试仍先于门禁执行（:168 先于 :169 的顺序保留，含注释说明） |
| 保留逐字核对 | 扫描过滤（status in ACTIVE/DEGRADED/EXHAUSTED、provider ACTIVE、双方 archived null）、PFA-09 静默整企业跳过、三种 attempt outcome 照写、成功行 cost_status='NOT_SUPPORTED'+PROVIDER_COST_API_NOT_SUPPORTED+文案、shanghaiSyncDay、canonical code 判定、快照字段组装 | 全部保留（diff 对照；唯一结构性提取 `inheritCostFacts` 为纯搬移） |

## 3. 实际执行的命令与结果

| 命令（cwd） | 结果 |
|---|---|
| `packages/config && pnpm test` | **15/15 通过**（新增 3 用例） |
| `apps/worker && pnpm vitest run … src/provider-operating-sync/runner.test.ts` | **3/3 通过**（真 Postgres 容器 pool20_025_operating_sync） |
| `apps/worker && pnpm test`（全量） | **36 文件 200/200 通过**（WP2 基线 199 → +1 为 runner 用例 2→3） |
| `apps/worker && pnpm test:integration` | **3 文件 10/10 通过**（含改造后的静默用例；stderr 中 runtime_assurance_tick_failed 为该套件自身的失败注入日志，非错误） |
| `packages/database && pnpm vitest run … wp3-operating-sync-decouple.integration.test.ts` | **3/3 通过** |
| `packages/database && pnpm vitest run … migration.integration.test.ts` | **7/7 通过**（该套件动态取"最后一条迁移"做 down/up——现即 0095，单行容器下 down 成功、重放成功） |
| `packages/database && pnpm vitest run … api-cost-estimation.integration.test.ts` | **10/10 通过**（0092→0093 回滚链现含 0095 于链首，down 顺序正常） |
| 三包 `pnpm typecheck` ＋ `pnpm lint`（config/worker/database） | 全部 0 错误（中途修复：未用变量 3 处；runner 合并后 complexity 31>30 → `inheritCostFacts` 提取；`cost_source` union 类型对齐 kysely-operations-tables.ts:265 含 LOCAL_LEDGER） |

## 4. 新测试用例清单（11 用例）

worker runner.test.ts（3）：
1. 周期门禁：T0 首轮成功（next_sync_at=T0+15min）→ 同刻/＋60s 两次 tick skip（fetch 计数不变、attempt 不增）→ T0+15min 恰到点放行（同日第 2 行 attempt＋第 2 版快照，sync_day 相等断言）→ env 覆盖 60s 后 next_sync_at=+60s → env 非法值 rejects 且零写入。
2. DARK/OFF 仍同步（OAB-03 场景 1 后端锚点）：OFF/DARK 各一轮成功，结果对象精确 `toEqual`（含 `!("skipped" in result)` 断言）；同批断言 8 张资金事实表（provider_finance_event/subscription_period/duplicate_candidate/idempotency/legacy_cost_resolution/usage_cost_disposition/operating_bill_resource_confirmation/resource_purchase_record）零增量——AT-OAB-04＋纯查询锚点。
3. 恢复链回归（原断言全保留并加强）：新隔离被更新官方证据解除（BALANCE_SYNC_RECOVERED→DEGRADED，两轮）；provider_balance_available=NULL 证据不恢复（保持 EXHAUSTED）；失败轮快照历史不新增、attempt FAILED/UPSTREAM_UNAVAILABLE、`last_success_data_at` 保鲜。

database wp3-operating-sync-decouple.integration.test.ts（3）：
4. 迁移水位含 0095：daily_uq 不存在；attempt 表可正常写入（表本体未变）。
5. 全链路（双容器之一）：0094 下同日第二行 23505 被拒 → 0095 后旧行保留＋同日 3 行可插 → down 被多行守卫拒绝（rejects /0095 down/）→ 失败 down 后索引仍不存在。
6. 单行路径（双容器之二）：down 成功且回滚名精确匹配 `0095_official_balance_sync_decouple` → 索引重建且同日第二行重新被拒（唯一性恢复）→ 重新 migrateToLatest 再次放开。

config（3）：默认值 900000/1800000/30000；env 覆盖；非法值 fail-fast（变量名＋毫秒单位）。

## 5. 范围外副作用处理

worker 全量测试触发 reporting 渲染副作用（WP2 report §4.3 同款已知现象）：`V4/Evidence/EMPLOYEE-QUOTA-REPORTING-20261101/reporting/` 下 2 个跟踪文件被重渲染＋11 个合成输出新文件。已按 WP2 先例 `git checkout --` 回置跟踪文件并删除全部合成输出，`git status` 复核工作树仅剩本合同范围改动。

## 6. 剩余问题 / 移交

- 0095 down 的多行守卫意味着：生产一旦以 P1 周期运行产生同日多行，`0095 down` 将拒绝（设计意图，回滚需先清场或接受拒绝）——已在迁移头注释与 §4 用例 5 钉死；S6 运维文档需写入。
- P2/P3 读取器已建齐未消费（S3 刷新冷却/S4 时效判定接线）。
- 静默 worker 测试的时间推进（16/32min）是对 P1 门禁的最小适配，静默语义断言未动——请总指挥复核该适配是否符合"不降低断言强度"要求（自评：满足，断言原样仅时钟前移）。
- 迁移编号下一枚为 **0096**（S3 refresh 请求表若需，按裁定 A 使用）。
