# 仟流智算 v2.2｜POOL20-036～044 本地修复候选 Evidence

| 项目 | 结果 |
| --- | --- |
| 基线 Commit | `c2ff5fa447326c139c14074d14c0a64ab879466c` |
| 基线 Tree | `0edf7d56e5ef2353b6c4e5c74496a2b844ac5df7` |
| 基线 Tag | annotated `v2.1`，tag object `1fa1d5e37d4c9ca0bd5be976888fecf7b753dbaa`，仍指向基线 Commit |
| 最终产品候选 Commit | `b2db531dee41e423a72d0a06b82e662558a6682a` |
| 最终产品候选 Tree | `438fc157520e0250f6e091a93b270b5bbfdd7b21` |
| 整改 Commit | `443a0a4294320e4bbf69af865564c45c138516f5`、`bead055f07e0ede74d36086264ae0eb817568d96`、`b2db531dee41e423a72d0a06b82e662558a6682a` |
| 本地分支 | `codex/v2.2-test-fixes` |
| 环境 | Node `v22.17.1`；pnpm `11.11.0`；PG17 Testcontainers／临时本地 PG17 `_e2e` |
| 数据边界 | 仅合成测试数据；未读取生产／客户数据，未调用真实 Provider |
| 发布边界 | 未 push、未建 PR、未部署、未移动或覆盖 `v2.1` |

## 1. POOL20-036～044 实现结果

| 问题 | 实现结果 |
| --- | --- |
| POOL20-036 | 统一模型、Model Route、计价规则归档统一先弹确认；正文及“取消／确认归档”按 Owner 冻结文案；取消零写入。 |
| POOL20-037 | RETIRED 调度策略拆成“恢复原配置／复制为新版本”。复制生成递增 DRAFT；恢复在同一事务内锁定并校验引用、创建递增 PUBLISHED、写审计；并发重试返回同一活动恢复版本，旧版本保持 RETIRED。 |
| POOL20-038 | 调度节省为 0、潜在金额不可算且避免扣减为 0 时，只展示“本月无可计算的实际切换”；存在有效值时才展示三层明细。 |
| POOL20-039 | 首页 API 行展示余额与余额桥接 API 花费；Coding Plan 展示套餐金额与登记订阅周期；套餐费用与经营账单共用月度经营结果，缺失时明确待补。 |
| POOL20-040 | 使用主体范围改为“在用／停用／归档”，默认在用；服务端按 `status + archived` 独立查询与计数。 |
| POOL20-041 | Coding Plan 业务利用率改为订阅周期 `used_quota / total_quota`；5 小时／周窗口继续独立展示；订阅周期与数据更新时间／窗口新鲜度分列。智谱 `2026-06-26～2026-09-26` 原样展示，不推断为月订阅。 |
| POOL20-042 | 用量主体搜索通过企业全量精确解析判定唯一；唯一时 Enter 应用 `subject_id`，跨 20 条分页重名时不误选。 |
| POOL20-043 | 唯一月度经营计算为 `API 花费 = 期初余额 + 本月 API 充值 - 期末余额`、`本月总花费 = API 花费 + 套餐费用`。使用最近有效快照；余额、充值、API 与套餐跨币种或缺币种均 fail-closed；API-only 套餐费用为 0，空企业保持未录入；冻结版本保存期初／期末快照 ID、版本与时间。 |
| POOL20-044 | 左上 Logo 与“仟流智算”合成一个 `/dashboard` Link，支持键盘并提供可访问名称“返回首页看板”。 |

## 2. 迁移与回退边界

- 新增加性迁移 `0052_dispatch_restore_and_resource_utilization`：增加 `restore_source_policy_id`、同源活动恢复唯一索引，以及资源月度利用覆盖索引。
- 升级不回写历史策略、账本或经营快照；若同一历史源已有多个活动恢复则 fail-closed，先对账再升级。
- down 只删除本迁移索引和恢复来源列；迁移回归覆盖 0052→0051 回退、重升和索引存在／移除边界。
- 应用回退不得删除已生成的新策略版本或经营事实；旧 RETIRED 与已关闭账单保持不可变。

## 3. 验证结果

| 检查 | 结果 |
| --- | --- |
| 受影响 Web 单测 | 归档确认、恢复／复制、零值首页、资源摘要、主体三范围、精确搜索 Enter、周期利用率、经营标签与 Logo 全部通过。 |
| 受影响 Control API／Database 集成 | 调度恢复历史不改、主体状态筛选、订阅周期利用率、余额桥接成功／缺期初／缺期末、关账冻结与账本核对证据全部通过。 |
| 最终固定全量回归 | `corepack pnpm@11.11.0 run test`：167 files／1152 tests，全部通过。 |
| 全 workspace typecheck | 11 个工程全部通过。 |
| 全 workspace lint | 11 个工程全部通过，warnings=0；新增复杂度 Finding 整改后通过。 |
| 全 workspace build | 11 个工程全部通过；仅保留既有 Web chunk warning。 |
| Coverage | 13 个 ratchet scope 无回退；pool043 Web branches 从首轮 `84.95%` 补测至 `85.78%`，未降 85% 门槛。 |
| 架构／源码体量／重复率 | 304 个生产源码文件无 runtime cycle；V3 历史门禁与基线一致；默认 400 行门槛通过；重复率 `0.65% < 5%`。 |
| 依赖／许可证 | production audit 无已知漏洞；许可证门禁通过。 |
| Sensitive canary | 日志命中 0；PG／Redis／Trace 仍为该命令未扫描范围。 |
| Web E2E | 专用本地 `qianliu_e2e`、Chromium：29/29 通过；临时 PG17 容器已删除。 |
| POOL043 mutation | Database `98.58%`，`gateway-ledger-guarded-writes` 100%；Gateway `90.99%`，`real-pipeline` 恢复冻结 `9/0`；v2.2 专项完整范围 `189/189 killed`、0 survivor／no-coverage。disposition 读取 7 份报告并通过。 |
| 迁移回归 | `0045→0052` 升级、0052 down、允许条件回退、重升与既有迁移回归全部通过。 |

## 4. Findings 与复审

1. 新分支使三个既有大函数复杂度越线；已提取纯函数／展示函数，未放宽复杂度阈值，lint 复审通过。
2. 旧回归仍把快照生命周期充值当本月充值；已改为只认当月采购记录，无记录为精确 0，并通过 POOL-010 回归。
3. 独立功能审计复现资源利用 P95 约 `2351ms > 1000ms`；新增月查询覆盖索引后，100 万 ledger 隔离与全量复跑约 `660～975ms`，未修改阈值。
4. pool043 Web 分支覆盖首次少 0.05%；补“待补期初余额＋账本核对证据”用例后为 85.78%。
5. E2E 首次缺 Chromium；安装锁定 Playwright build 后复跑。随后校准三处已过时的 E2E 断言／确认流程，最终 29/29。
6. V1.4 首轮功能／代码审计为 FAIL；有界整改关闭跨币种、恢复原子性与并发、mutation、历史门禁、有效快照、全局精确匹配和冻结证据 Findings。
7. 最终功能复审 `PASS_REBOUND`，代码质量复审 `PASS`；CQ-F-001～009 全部关闭，剩余 P0/P1/P2/P3 为 0/0/0/0。实际独立性 I1。

最终复审：遗留 P0/P1 为 0；未发现越权、历史改写、标签移动或范围外重构。

## 5. 文件清单与职责

- Control API：`principals/routes.ts`、`read-models/routes.ts`、`resource-insights/query.ts`，以及对应集成测试与 E2E seed。
- Database：新增月度经营计算与调度克隆模块、0052 迁移；调整 dashboard、operating bill、dispatch policy、principal 仓储／类型／测试。
- Web：Dashboard、QuotaRules、Principals、UsageSubjectPicker、ResourceUtilizationPanel、OperatingBill、Sidebar 及 API 类型／测试／E2E。
- 质量与报告：V3 历史门禁保持与基线一致；更新既有 POOL043 报告并新增已绑定候选的 v2.2 专项 mutation 报告。
- 完整机器清单：`git diff --name-status c2ff5fa447326c139c14074d14c0a64ab879466c..b2db531dee41e423a72d0a06b82e662558a6682a`。

## 6. 未覆盖风险

- 未接触真实 Provider、生产／客户数据和目标部署；本 Evidence 不是生产验收。
- 智谱登记周期与 Owner 所述月订阅仍冲突；本批只诚实展示登记事实，是否修正后台数据需 Owner 另行确认，不能在代码中伪造。
- 日志 canary 不覆盖 PG／Redis／Trace；未将该项表述为全存储扫描通过。
- 双阶段复审独立性为 I1（同模型族、不同独立上下文），不冒充 I2；本结论不授权 push、部署或生产复测。
