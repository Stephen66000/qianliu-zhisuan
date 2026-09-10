# C4 交接（R03 G01/G02 门禁整改候选）

日期：2026-09-10。实施：ZCode；状态：**待 Codex 复核（V14-C4 报告）**。历史证据（C1/C2/C3/R01/R02/R03/V14-C2）原样保留。

## 1. 候选标识与冻结

- 候选：`HOME-STANDARD-C4-20260910`
- 基线：分支 `codex/quota-pricing-review-20260905`，HEAD `4898df546fbcbc9ca292ee892cd7ae412766185a`（未提交、未推送、未合并、未部署）
- C4 tracked patch：15 文件，SHA256 `f9549068868d88fe7260774a6d7f119ffebca1f800e18e6d1eaf39f486e3855d`
  （相对 C3 `97bc6b57…` 的增量仅为 `packages/database/src/index.ts` 新增 2 个导出；其余 tracked 内容不变）
- 新增文件 15 项逐文件 SHA256：`candidate-new-files.sha256`
- 起止锁 STABLE；本轮未触碰共享 `packages/database/reports` 目录（R03 要求）。

## 2. 本轮差异（C3 → C4）

**业务/接口（2 处，均由新测试暴露或为测试可达性）**

| 文件 | 变化 | 依据 |
| --- | --- | --- |
| `dashboard-home-costs.ts` | 真实缺陷修复：缺币种遗留已计价行（currency=null）使同期费用币种分组崩溃；改为跳过 null 币种行、缺口单列（与权威月度汇总口径一致） | G02b 注入测试暴露（F-G） |
| `dashboard-home-metrics.ts` | `previousEmployeeWindow` 增加企业存在性守卫：不存在时显式抛 `UsageOverviewEnterpriseNotFoundError`，不再静默返回空窗 | F-H |
| `packages/database/src/index.ts` | 导出上述两个函数 | 测试可达性 |

**测试（3 文件）**：integration 追加 6 用例（状态恢复/异常文案、桥接完整、桥接故障注入、bill fallback、企业缺失、六缺口码正/反控制注入）；新增 `dashboard-home-costs.test.ts`（bridgeIncompleteReason 六分支）；web model 单测扩至 22 项（buildOverviewCards 双期可比性/费用完整性全分支断言，作为 G02a 变异 runner）。

## 3. R03 整改对照

| 项 | 状态 | 证据（本目录 / V14-C4 目录） |
| --- | --- | --- |
| G01 覆盖率门禁 | **关闭**：同 5 运行时文件、原 85% 阈值、业务断言补齐后 exit=0；stmts 99.79% / branches **92.59%** | C4/coverage-db.log |
| G02 变异证据范围 | **关闭**：核心规则映射表 + 有界变异（web 可比性/费用完整性：243 变异体、killed 218、**89.71%**、exit=0）+ 费用完整性六码正/反控制数据级注入（真实 PG）；范围与限制准确标注（web 存活 24+1 个为展示串字面量/等价变异，清单已归档；DB SQL 规则未做变异，以数据级注入替代） | C4/mutation-web.log、C4/mutation/、integration 测试 |
| 基线归因范围 | **关闭**：干净基线 worktree 逐文件复现——13 项确定性断言失败全部基线复现（同 `0067 vs 0064/0066` 因）；`w20-standard-capacity`（P95 计时）基线通过，单列为不稳定用例 | V14-C4/baseline-db-batch1.log、batch2、capacity、baseline-api.log |
| V14-C2 报告修正 | **完成**：卷首更正附录（覆盖率"伪影"说法撤销、PASS 标注不被 R03 接受）；§4 外推表述修正；原文保留 | V14-C2/report.md 卷首附录 + §7 内联注记 |

## 4. 门禁回执（C4/gate-*.log，全部 exit 0）

typecheck（全仓）、lint（全仓 0 警告）、size；web 全量 **52 文件/292 用例**；database 候选 **25 项**（窗口单测 6 + costs 单测 6 + PG 集成 13）——[更正 R04：原记载 18 项为笔误，回执合计为 25]；control-api 路由 2 + 金融回归 9；coverage-db exit=0；mutation-web exit=0（89.71%）。

既有迁移失败（13 项）维持不修——已证与候选无关（§3）；容量用例不稳定项单列。

## 5. 本地复现

无新增运行依赖。覆盖率/变异命令与参数完整记录于 V14-C4 报告 §2/§3 与 mutation/ 目录配置副本；复跑即可得到同范围结果。

## 6. 残余风险

- 变异存活 25 个（24 Survived + 1 NoCoverage）：展示措辞字面量与等价变异为主，清单在 mutation/reports/home-model.json；后续如做文案测试可再收敛。
- 生产量级性能、共享 StatusTag 深色、WCAG 定量抽查：沿袭未变（R03 亦列为非本轮整改项）。
- F-F（未配置同步计入"需关注"）语义待产品裁决，未变。
