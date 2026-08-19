# 仟流智算 2.1｜第二轮整改双审通过 Evidence

| 项目 | 结果 |
| --- | --- |
| 唯一基线 Commit／Tree | `7305abb9d62f9e3d5702e08f3a285d7ceffc88ad`／`0fd9a508e778db7f8a4ab185f1f5f9ae7e64a218` |
| 冻结文档提交 | `38d583fc3872a035e5b34b66951b1d9a420bc41e` |
| 本地分支 | `codex/v2.1-test-fixes-r2` |
| 双审通过代码对象 | `72cef647d2ea722c6a960a8137b010552b0ea90a`／Tree `4b7f6e5a1c2f16c2079c5add77c4f31991377eda` |
| 版本边界 | `v2.1` Tag 未移动；未退回或覆盖历史分支 |
| 发布边界 | 未 push、未部署、未创建 PR |
| 数据边界 | 合成数据与专用 `_e2e` 数据库；未读取生产／客户数据，未调用真实 Provider |

## 1. POOL20 结果

| 编号 | 本地候选结果 |
| --- | --- |
| 038 | 空态同时要求实际切换数为 0；有切换但节省为 0 时保留原因与三层事实。 |
| 039 | 六项经营金额按币种独立保留；只有不可合计标量 fail-closed，USD 不再被固定 `¥／元` 误标。 |
| 041 | 资源利用、采购复盘、经营账单套餐判断／闲置金额共同要求完整订阅起止；厂商窗口仍独立展示。 |
| 042 | Enter 精确匹配绑定请求代际、主体类型和搜索词；过期响应、跨页重名均不误选。 |
| 043 | 采购复盘与经营账单共用余额桥接 API 花费；账本只标核对证据，缺口 code／field／reason 逐项准确。 |
| 045 | 真实 Token 固定输入＋输出；结算时间统一首页／概览／明细／聚合；Kimi 缺维度、非法值及六级质量同源解释。 |
| 046 | 0053 期初事实与审计原子写入；同资源同币种上月期末优先；北京时间匹配、多资源 UX、租户 actor 与不可变均覆盖。 |
| 047 | 六项按正确币种独立展示；CNY／USD／跨币种／无余额有充值反例均保留已知事实。 |

`POOL20-036`、`037`、`040`、`044` 只做固定回归，均保持通过。下一可用编号仍为 `POOL20-048`。

## 2. 迁移必要性与安全边界

现有 `provider_resource_operating_snapshot` 以递增版本表达资源当前经营事实。把历史月份期初余额补录为
经营快照，会使旧余额参与当前指针、资源摘要和预测，因此无法安全复用。0053 只新增
`operating_bill_opening_balance`：

- 事实按企业、账期、资源、版本追加；更新／删除由不可变触发器拒绝。
- 账期、资源和操作人均使用企业复合外键，跨企业引用由数据库拒绝。
- 同一 payload 重放不追加版本；人工纠错才生成下一版本。
- 同资源同币种上月已关闭期末优先于人工和月初快照；异币种上月事实不堵塞有效回退。历史补录不修改资源当前快照。
- 财务事实与 `operation_log` 同一事务；审计失败整体回滚，同 payload 重试可恢复。
- 表内已有事实时 down fail-closed；空表允许回退并移除本迁移索引／表。

0054 的必要性来自既有 `usage_bucket_aggregate` 已按请求开始时间物化，直接改查询会继续命中旧语义缓存。0054：

- 扩展 `usage_event` 质量约束以接受缺可选维度的 `MIXED` 事实；存在该事实时旧版本回退 fail-closed。
- 升级清除派生聚合／水位／dirty 队列，并按 `ledger_transaction.created_at` 结算时间重新标记小时和自然日桶。
- 回退先按旧 `ai_request.started_at` 语义重建 dirty 边界，避免跨语义缓存残留。
- 新旧质量约束使用 `NOT VALID`，避免迁移时扫描全部历史 `usage_event`；发布合同在停写窗口完成 DDL 与 dirty 标记。
- 100 万既有 ledger＋100 万既有 usage_event 三次实测迁移 `4509ms／4764ms／4534ms`，产生并恢复 `776` 个 dirty 桶；批次上限 `1000`。注入 dirty 写失败时迁移事务整体回滚至 0053。
- Worker 常驻安全调度每轮消费小时／自然日 dirty 桶（默认各 `200`，配置范围 `1..1000`）；聚合失败与运行保障任务隔离，后续 tick 重试。

发布脚本 `deploy/scripts/release-v2.1-r2-mac-mini.sh` 只提供合同、未执行部署：固定候选分支，运行时要求完整 Commit／Tree；仅接受源迁移 0052，目标 0054；校验 0053／0054，先停写与校验备份，再升级；数据库已变化的失败路径保持业务停写，并输出从备份恢复的边界。脚本不创建或移动 Git Tag。

## 3. 验证结果

| 门禁 | 结果 |
| --- | --- |
| 运行时 | Node `v22.17.1`；pnpm `11.11.0` |
| 全 workspace | typecheck、lint（warnings=0）、build 全部通过；Web 保留既有 chunk warning |
| 固定有界全量回归 | 172 files／1197 tests，分段全部通过 |
| 受影响定向 | Web 41；月度经营单测 18；Control API 实库 32；Database／迁移实库 21；Worker／发布合同 4 |
| Web E2E | 专用 `qianliu_e2e`、备用端口、Chromium 29/29 |
| 标准容量 | 100 万 ledger P95 冻结阈值保持 `<=1000ms`，完整复跑通过 |
| Coverage | 13 个 ratchet scope 无回退；扩展 Node `96.52/87.85/98.02/96.52`；Web `97.72/85.20/90.17/97.72` |
| Mutation | Database 本轮 `327/327`、Kimi 既有 `44/44` killed；均 0 survivor／0 no-coverage，100% |
| 架构／体量／重复率 | 315 个生产源码文件无 runtime cycle；默认 400 逻辑行门禁通过；重复率 `0.67%` |
| 依赖／许可证 | production audit 无已知漏洞；许可证门禁通过 |
| Sensitive canary | 日志 0 hits；PG／Redis／Trace 未扫描 |

## 4. 主要文件

- Control API：经营账单期初补录路由、原子审计、采购复盘余额桥接、资源周期利用查询及对应实库回归。
- Database：0053／0054、Kysely 类型、期初事实、按币种月度经营汇总、结算时间聚合、质量模型及迁移回归。
- Provider Adapter：Kimi 与 OpenAI-compatible usage 缓存字段兼容及测试。
- Web：首页空态／经营缺口、资源币种、订阅周期、主体异步防竞态、经营账单六项与补录入口及测试。
- Worker：常驻 usage aggregate dirty 消费、小时／日批次边界及失败隔离测试。
- 发布：2.1 第二轮 Mac Mini 0052→0054 静态发布合同与独立脚本测试；未部署。
- 质量：扩展 Coverage；POOL043-v22 与 POOL021-r2 两份 100% mutation 报告；V4 蓄水池、测试记录和本 Evidence。

完整机器清单以 `git diff --name-status 38d583f^..HEAD` 的最终本地候选为准。

## 5. 未覆盖风险

1. 本候选未接触目标部署环境、真实 Provider 或生产／客户数据，不代表生产业务验收。
2. E2E 使用本机专用 `_e2e` 数据库与合成夹具，不证明生产历史快照质量。
3. Sensitive canary 只扫描日志，不能解释为 PostgreSQL／Redis／Trace 全域零泄漏。
4. 双路独立复审与 V1.4 代码审核已在上述代码对象上通过，`P0/P1/P2/P3 = 0/0/0/0`；仍待 Owner／生产验收。
