# 仟流智算 2.0｜V1.4 全量功能与代码质量审核

| 项目 | 结果 |
| --- | --- |
| Audit ID | `AUDIT-2.0-20260819-V14-R1` |
| 项目／阶段 | 仟流智算 2.0／Stage 03 修复候选 |
| 审核合同 | R20-11；《仟流智算 2.0 Review 与交付收口方案》 |
| 审核对象 | Commit `a2e91daf0dc2d0b19d8e1ab5773ea4a2c68567d9`；Tree `a79685cdc959ed4a69df226550bee91a8d766482` |
| 基线 | 2.0 release 候选 `16f880359fda50449b034dcfd1c7e755c8e83666`，叠加两组修复及本轮整改 |
| 审核范围 | 两组 11 项修复涉及的 apps、packages、迁移、测试、配置和质量门禁 |
| 风险级别 | R3：Gateway、计量、结账和数据库迁移同时变化 |
| 实际独立性 | I0：本轮由总协调执行，未冒充独立 Reviewer；独立性事实已披露 |
| 审核结论 | `PASS_WITH_I0_DISCLOSURE`：机械门禁、功能验收和整改复审通过 |

## 1. 审核范围与功能结论

### 1.1 两组修复自测

- 第一组 6 项：Commit `0107df2be6f542140e3059a1470d770c4dcce82f`，自测通过。
- 第二组 5 项：Commit `02221f5a83ff3eb28d48a185c06c15eef746003e`，自测通过。
- 合并后的候选重新执行：Control API `34/34`、Gateway `33/33`、Database `5/5`、Worker `1/1`、Provider Adapter `2/2`、Web `43/43`，全部通过。

### 1.2 11 项新问题回归

POOL20-025、026、027、028、029、030、031、032、033、034、035 均有对应实现和回归断言；涉及每日同步、结账事实确认、策略复制／归档、时间线、调度／计价分块、技术详情折叠、额度耗尽提示、首页 8 卡和三层节省口径。

### 1.3 2.0 中继承的 1.0 能力回归

本次没有启动独立 1.0 环境；验证对象是 2.0 候选上的 1.0 继承能力。固定有界全量回归结果：**165 个测试文件／1124 个测试全部通过**，覆盖认证、主导航、首页资源摘要、主体与 Key、厂商资源、额度规则、用量账本、运行保障、管理员、Gateway 公共协议、结账和历史账本守恒。

## 2. V1.4 机械门禁

| 门禁 | 结果 | Evidence／说明 |
| --- | --- | --- |
| typecheck | PASS | 11 workspace projects |
| lint | PASS | 11 workspace projects，warnings=0 |
| unit／integration／regression | PASS | bounded runner：165 files／1124 tests |
| build | PASS | 11 workspace build；Web 仅有既有 chunk warning |
| coverage | PASS | domain 97.67/91.10/96.55；Web pool043 98.30/85.39/91.91/98.30；13 个 ratchet scope 通过 |
| architecture | PASS | 300 production source files，无 runtime cycle |
| source size | PASS | 默认阈值仍为 400 logical lines；超长文件均有 Owner、原因、复核日期和退出条件的显式例外 |
| duplication | PASS | 0.70%，低于 5% 门槛 |
| dependency vulnerability | PASS | `pnpm audit --prod --audit-level moderate`：No known vulnerabilities |
| license | PASS | 生产依赖许可证门禁通过 |
| sensitive canary | PASS（有限范围） | 日志 0 hits；PG／Redis／Trace 未由本命令扫描，未冒充全域通过 |

## 3. Findings、整改与复审

| Finding | 优先级 | 原因 | 整改 | 复审结果 |
| --- | --- | --- | --- | --- |
| F-001 迁移编号冲突及旧回归断言仍假设 0049 为最新 | P1 | Group 2 使用了已有 `0045_zhipu...` 的重复编号；新增迁移使 6 个历史迁移测试失败 | 重排为 `0050_group2_policy_lifecycle` 与 `0051_pool20_operating_sync_and_closing_confirmation`；更新升级／回退断言 | 6 个迁移测试通过；全量回归恢复 165/1124 |
| F-002 Web pool043 覆盖率不足 | P2 | branches 82.56%、functions 87.40%，低于 85%／90% 阈值 | 增加结账、重开、资源事实确认、CSV 解析、Coming Soon 回归测试；不降低阈值 | Web pool043 98.30% statements、85.39% branches、91.91% functions、98.30% lines |
| F-003 源码大小例外未覆盖本轮候选增长 | P2 | 8 个文件超过旧基线或未登记例外 | 保留默认 400 行阈值；补齐当前候选的显式例外、Owner、复核日期和拆分退出条件 | source-size gate 通过；复核日期 2026-09-18 |

复审使用同一最终候选；整改没有修改业务验收口径、没有降低 coverage／duplication／source-size 默认阈值，也没有改写失败事实。

## 4. 残余风险与未覆盖范围

1. 未调用真实 Provider、未操作生产／客户数据、未部署；本报告是本地最终候选审核，不是目标环境部署验收。
2. DeepSeek 厂商未公开费用 API；厂商费用同步诚实标记 `NOT_SUPPORTED`，API 实际费用继续取已结算 Ledger。
3. canary 本轮只扫描日志；PG、Redis、Trace 未扫描，不能把该项解释成全域敏感信息零泄漏。
4. 实际审核独立性为 I0；本报告不冒充由独立 AI／Reviewer 出具的正式独立 Audit。

## 5. 结论

当前候选的功能验收、1.0 继承回归、代码质量门禁和 Findings 整改复审均已完成并通过。`PASS_WITH_I0_DISCLOSURE` 只表示本轮总协调审核结果；如工程封板合同要求 I1／I2 独立 Reviewer，仍需在同一 Commit／Tree 上补做独立复核，不能用本报告替代。
