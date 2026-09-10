# C5 交接（R04 G02 整改候选）

日期：2026-09-10。实施：ZCode；状态：**待 Codex 复核（V14-C5）**。历史证据（C1–C4/R01–R04/V14-C2/V14-C4）原样保留。

## 1. 候选标识与冻结

- 候选：`HOME-STANDARD-C5-20260910`
- 基线：分支 `codex/quota-pricing-review-20260905`，HEAD `4898df546fbcbc9ca292ee892cd7ae412766185a`（未提交、未推送、未合并、未部署）
- C5 tracked patch：**与 C4 字节一致**，SHA256 `f9549068868d88fe7260774a6d7f119ffebca1f800e18e6d1eaf39f486e3855d`（本轮仅改 untracked 测试文件，无生产代码变化）
- 新增文件 15 项逐文件 SHA256：`candidate-new-files.sha256`（变化：standard-home-model.test.ts、standard-home.integration.test.ts）
- 起止锁 STABLE；共享 reports 目录零操作。

## 2. 本轮差异（C4 → C5，全部为测试）

| 文件 | 变化 |
| --- | --- |
| `apps/web/src/components/dashboard/standard-home-model.test.ts` | 新增 moneyChangePercent 币种守卫 4 项（R04 132/127）、buildOverviewCards 区分性/精确文案断言 8 项、tokenQualityLabel 三态直测、costGapLabel 六码映射全表；model 单测 22 → 34 |
| `packages/database/src/__tests-integration__/standard-home.integration.test.ts` | 无功能变化（C4 已含全部用例；本轮仅格式随 earlier 批次一致） |

## 3. R04 整改对照

| R04 要求 | 状态 | 证据 |
| --- | --- | --- |
| 补 moneyChangePercent 双 null 断言（132/127） | **完成** | 4 项测试；复跑同范围变异 L137/138 全部 Killed |
| 复跑同范围确认 127/132 被杀死（按 location+replacement） | **完成** | 97.53%、exit 0；JSON 逐项核验 |
| 其余存活逐项定性（含 id8/id86/id185 类） | **完成** | 6 项定性表（3 等价 + 3 ground truth 检测假阳性），含注入实测结果；V14-C5 §2 |
| 修正"逻辑变异全部杀死"结论 + DB 计数笔误（25 非 18） | **完成** | V14-C4/report.md 更正记录章节 + C4/handoff.md 行内更正；V14-C5 §3 |
| 保留历史证据、不清理共享 reports、仅本地 | **遵守** | 目录清单见下 |

## 4. 门禁（C5/gate-*.log）

typecheck/lint/size 0；web 全量 305；DB 候选 25；变异 243 变异体 killed 237（97.53%，exit 0）+ ground truth 检测 3 → 有效 240/243（98.8%）。

## 5. 残余与风险

- Stryker 归因假阳性 3 个（#8/#86/#207）：ground truth DETECTED；属 vitest-runner 覆盖归因/V8 模板映射的工具局限，已存证。
- 等价变异 3 个（#16/#175/#178）：推导与注入实测均记录。
- 沿袭残余不变：生产量级性能、共享 StatusTag 深色、WCAG 定量、F-F 产品裁决。
- 本轮无生产代码变更、无 UI 变化 → 未重复浏览器验证。

## 6. 复现

变异复跑：在 apps/web 放回 `C5/mutation/` 下的两份配置副本（stryker.home-model.config.json / vitest.home-model-mutation.config.ts）后执行 `corepack pnpm@11.11.0 exec stryker run stryker.home-model.config.json`；其余门禁命令见 gate-*.log 首行。
