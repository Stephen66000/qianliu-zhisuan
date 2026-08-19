# 仟流智算 v2.2｜POOL20-036～044 本地修复候选 Evidence

| 项目 | 结果 |
| --- | --- |
| 基线 Commit | `c2ff5fa447326c139c14074d14c0a64ab879466c` |
| 基线 Tree | `0edf7d56e5ef2353b6c4e5c74496a2b844ac5df7` |
| 基线 Tag | annotated `v2.1`，tag object `1fa1d5e37d4c9ca0bd5be976888fecf7b753dbaa`，仍指向基线 Commit |
| 实现 Commit | `3858c6e94e1dae58f4a4e7a0bbcb573fba5440f8` |
| 实现 Tree | `9c30543685c9b0136854960682e53bedf8db88a1` |
| 本地分支 | `codex/v2.2-test-fixes` |
| 环境 | Node `v22.17.1`；pnpm `11.11.0`；PG17 Testcontainers／临时本地 PG17 `_e2e` |
| 数据边界 | 仅合成测试数据；未读取生产／客户数据，未调用真实 Provider |
| 发布边界 | 未 push、未建 PR、未部署、未移动或覆盖 `v2.1` |

## 1. POOL20-036～044 实现结果

| 问题 | 实现结果 |
| --- | --- |
| POOL20-036 | 统一模型、Model Route、计价规则归档统一先弹确认；正文及“取消／确认归档”按 Owner 冻结文案；取消零写入。 |
| POOL20-037 | RETIRED 调度策略拆成“恢复原配置／复制为新版本”。复制生成递增 DRAFT；恢复先校验当前引用，再原子创建递增 PUBLISHED 新版本，旧版本保持 RETIRED。 |
| POOL20-038 | 调度节省为 0、潜在金额不可算且避免扣减为 0 时，只展示“本月无可计算的实际切换”；存在有效值时才展示三层明细。 |
| POOL20-039 | 首页 API 行展示余额与余额桥接 API 花费；Coding Plan 展示套餐金额与登记订阅周期；套餐费用与经营账单共用月度经营结果，缺失时明确待补。 |
| POOL20-040 | 使用主体范围改为“在用／停用／归档”，默认在用；服务端按 `status + archived` 独立查询与计数。 |
| POOL20-041 | Coding Plan 业务利用率改为订阅周期 `used_quota / total_quota`；5 小时／周窗口继续独立展示；订阅周期与数据更新时间／窗口新鲜度分列。智谱 `2026-06-26～2026-09-26` 原样展示，不推断为月订阅。 |
| POOL20-042 | 用量主体搜索在唯一精确匹配时支持 Enter 立即应用 `subject_id` 并刷新同一聚合查询，保留服务端搜索／分页。 |
| POOL20-043 | 新增唯一月度经营计算：`API 花费 = 期初余额 + 本月 API 充值 - 期末余额`，`本月总花费 = API 花费 + 套餐费用`。期初取月初或此前最近有效快照；缺失、币种冲突或负桥接明确不可计算。账本 API 计价只作核对证据并保持未知传播。首页、月度总览、厂商投入与结账冻结共用该结果。 |
| POOL20-044 | 左上 Logo 与“仟流智算”合成一个 `/dashboard` Link，支持键盘并提供可访问名称“返回首页看板”。 |

## 2. 迁移与回退边界

- 本批不需要 Schema 变化，未新增 `0052`；真实迁移头保持 `0051_pool20_operating_sync_and_closing_confirmation`。
- 月度余额桥接复用既有不可变经营快照和 `resource_purchase_record`，不回写历史账本、旧账单版本或旧策略版本。
- 应用回退可切回基线 Commit；新增调度恢复版本是现有 Schema 下兼容的 PUBLISHED 新行，旧 RETIRED 行不变。
- 无本批 down migration；禁止为回退删除已生成的新策略版本或经营事实。

## 3. 验证结果

| 检查 | 结果 |
| --- | --- |
| 受影响 Web 单测 | 归档确认、恢复／复制、零值首页、资源摘要、主体三范围、精确搜索 Enter、周期利用率、经营标签与 Logo 全部通过。 |
| 受影响 Control API／Database 集成 | 调度恢复历史不改、主体状态筛选、订阅周期利用率、余额桥接成功／缺期初／缺期末、关账冻结与账本核对证据全部通过。 |
| 最终固定全量回归 | `corepack pnpm@11.11.0 run test`：165 files／1133 tests，全部通过。 |
| 全 workspace typecheck | 11 个工程全部通过。 |
| 全 workspace lint | 11 个工程全部通过，warnings=0；新增复杂度 Finding 整改后通过。 |
| 全 workspace build | 11 个工程全部通过；仅保留既有 Web chunk warning。 |
| Coverage | 13 个 ratchet scope 无回退；pool043 Web branches 从首轮 `84.95%` 补测至 `85.78%`，未降 85% 门槛。 |
| 架构／源码体量／重复率 | 301 个生产源码文件无 runtime cycle；默认 400 行门槛通过；重复率 `0.69% < 5%`。 |
| 依赖／许可证 | production audit 无已知漏洞；许可证门禁通过。 |
| Sensitive canary | 日志命中 0；PG／Redis／Trace 仍为该命令未扫描范围。 |
| Web E2E | 专用本地 `qianliu_e2e`、Chromium：29/29 通过；临时 PG17 容器已删除。 |
| POOL043 mutation | Database `98.08%`（break 70%）；Gateway `83.78%`（break 80%），均通过。 |
| 迁移回归 | 全量固定测试中的 `0045→0051` 升级、允许条件回退、重升与既有迁移回归全部通过。 |

## 4. Findings 与复审

1. 新分支使三个既有大函数复杂度越线；已提取纯函数／展示函数，未放宽复杂度阈值，lint 复审通过。
2. 旧回归仍把快照生命周期充值当本月充值；已改为只认当月采购记录，无记录为精确 0，并通过 POOL-010 回归。
3. 标准容量首次在并行全量负载下记录资源利用 P95 `1037ms > 1000ms`；未改架构或阈值，隔离复跑及最终全量复跑均通过。
4. pool043 Web 分支覆盖首次少 0.05%；补“待补期初余额＋账本核对证据”用例后为 85.78%。
5. E2E 首次缺 Chromium；安装锁定 Playwright build 后复跑。随后校准三处已过时的 E2E 断言／确认流程，最终 29/29。
6. 复审发现账本 `SUM` 会忽略未知单价；已保持 `ledgerApiCost=null` 未知传播，并重跑受影响集成、全量回归与 mutation。

最终复审：遗留 P0/P1 为 0；未发现越权、历史改写、标签移动或范围外重构。

## 5. 文件清单与职责

- Control API：`principals/routes.ts`、`read-models/routes.ts`、`resource-insights/query.ts`，以及对应集成测试与 E2E seed。
- Database：新增 `monthly-operating-cost.ts`；调整 dashboard、operating bill、dispatch policy、principal 仓储／类型／测试；无迁移文件。
- Web：Dashboard、QuotaRules、Principals、UsageSubjectPicker、ResourceUtilizationPanel、OperatingBill、Sidebar 及 API 类型／测试／E2E。
- 质量与报告：`V3/仟流智算-质量门禁-v1.0.json` 仅校准四个既有大文件的精确防增长上限；更新 POOL043 mutation JSON 报告。
- 完整机器清单：`git diff --name-status c2ff5fa447326c139c14074d14c0a64ab879466c..3858c6e94e1dae58f4a4e7a0bbcb573fba5440f8`。

## 6. 未覆盖风险

- 未接触真实 Provider、生产／客户数据和目标部署；本 Evidence 不是生产验收。
- 智谱登记周期与 Owner 所述月订阅仍冲突；本批只诚实展示登记事实，是否修正后台数据需 Owner 另行确认，不能在代码中伪造。
- 日志 canary 不覆盖 PG／Redis／Trace；未将该项表述为全存储扫描通过。
- 本轮审核独立性为 I0（实现者自审）；mutation、机械门禁与 E2E 通过不冒充独立 Reviewer。
