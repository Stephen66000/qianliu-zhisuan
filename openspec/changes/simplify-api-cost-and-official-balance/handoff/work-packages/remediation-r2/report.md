# 返修轮 R2 结包报告：R1 复审闭合

轮次：R2（R1 复审三类条件闭合）；总指挥：GLM-5.3（复核与文档）；实施：glm-flash（R2-1 根治、R2-2 复跑）。日期：2026-11-05。前提提交：复审记录 `b56c31a`。

## 1. 结论

R1 复审三类条件全部闭合，交回验收人复审。原四阻断 PASS 判定未被撤销（验收人明示）；X02 重开项已根治＋三连复跑全绿（终判权留验收人）；干净复跑/数字/证据绑定按 C2/C3 完成。

## 2. 闭合对照

| 条件 | 动作 | 证据 |
|---|---|---|
| C1 AT-X02 三连失败不可环境豁免 | **根治**：convergeExpiredLeases 判定与留痕改 DB 侧 now()（单条 UPDATE 同钟基准；租约时长/冷却/幂等/状态机合同不变，diff 单点）；探针入档实测 skew +1.2~1.3s 并捕获宿主时钟阶跃；skew 负向用例（2s 裕量反证宿主钟回退必败）；三连复跑 8/8×2＋批量上下文 44/44＋db 批 12/12 | remediation-r2/logs r2-01/02/03 |
| C2 数字与干净复跑 | database 单测 245＋集成 610/610 全批 exit 0（4 文件 teardown 排空加固）；全库集成 612/613（W20-10 红如实：本轮 resourceUtilization 1540.44；usage-aggregate-capacity 单跑 368.96s 过＝边界状态）；gateway 全量一次 250/250 exit 0；根 build exit 0 | r2-10~18、r2-20、r2-23 |
| C3 证据绑定 SHA | .gitignore 例外 `!V4/Evidence/**/*.log`（业务日志仍忽略，check-ignore 验证）；R1 31 份＋R2 全部日志入库；提交链更正（7ceb97e 系 amend 替换，实际祖先链 `686100f→ea45c4f→0899f04→b56c31a→本轮`）；过时表述清理（usage-overview 两处"规则现值"注释、WP1 合同 §1 priceBasis v1.2） | git；本文档 |

## 3. 同类点清单（R2-1 调查，只修根因一处其余记录）

refresh 冷却判定、F4 读侧 SYNCING/expired/next_refresh_at（宿主 now vs DB 时间，读侧秒级偏差有界）、credential-chat-probe、activation 租约、admin session——均记录在 R2-1 回报与 matrix-r1 R2 段；是否统一根治待验收人/用户裁定（本轮红线只修 AT-X02 根因）。

## 4. 如实披露

- R2-2 a1/a2 首跑 stdout 日志被复跑同名覆盖（首跑退出码/用例数/错误文件记录于复跑日志头与本报告；排空修复文件清单完整）。
- operating-feedback 在 12 文件并行负载下一次偶发断言失败（单跑 8/8＋整批复跑 126/126 均过；未定位根因，列为关注项）。
- W20-10 断言轮换（R1 subjectUsage 1029.86 / R2 resourceUtilization 1540.44）——震荡实证，CI 硬门不变；性能修复（批量估算改造）仍待用户裁定，不在 R2 范围。
- usage-aggregate-capacity 368.96s vs 600s 限值＝边界通过，后续轮次有超时风险。

## 5. 提交

业务：convergeExpiredLeases 根治＋skew 负向用例＋4 文件 teardown 排空＋两处注释语义更正。文档/证据：.gitignore 例外＋R1/R2 全部日志＋development-summary/matrix-r1/WP1 合同/R1 报告更新＋本报告＋plan。
