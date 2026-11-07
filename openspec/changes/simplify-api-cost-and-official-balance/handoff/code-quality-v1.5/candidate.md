# 候选标识与完整范围（送审 §5.1/5.2）

## 候选

- 分支：`codex/simplify-api-cost-and-official-balance`（worktree /Users/mac/Projects/仟流智算-api-decouple）
- base（阶段授权起点）：`ae506fed47d21865420afa91137e8b244072933e`（远端 main，PR #7）
- 预检候选：`d82559f09aab75bac6a1e1e9d80b228d56c0f057`（X07 R5 完成态，验收人功能复判 18/18 的对象）
- **整改后送审候选：`38ab493`**（本目录材料与对象锁绑定；最终 SHA 以 candidate-lock.json 的 HEAD 为准）
- 完整阶段范围＝base..送审候选 全部提交（git log ae506fe..HEAD），含七工作包业务/文档/证据＋X07 R3/R4/R5＋质量整改四笔：`56d5fa7`（CQ-01）＋`dbcecd8`/`17650a6`/`38ab493`（GATE-01 三批）。**不拿本轮修复 diff 冒充整阶段。**

## 功能结论与新候选的绑定（§5.2）

| 功能证据 | 原绑定 | 送审候选处置 |
|---|---|---|
| 50 条矩阵 50/50（终审）＋走查签收 | d82559f 及其前史 | CQ-01/GATE-01 为脚本防护与纯结构拆分；GATE-01 受影响域定向回归约 380 用例＋web 全量 773/773×2 由子 Agent 跑、总指挥抽复跑（typecheck/lint/source-size/architecture/X07 11＋7 于 38ab493 亲跑）。拆分文件涉及的金额合同域（operating-bill-draft/breakdown/analysis/activation）集成用例全绿，功能结论**可沿用** |
| X07 主路线＋down 链（11＋7） | d82559f | **已在送审候选重验**（总指挥亲跑，见上）——CQ-01 改了脚本与调用方 |
| W20-10 四项 P95 | `7d28c4a` 后标定 | GATE-01 拆分未触碰聚合 SQL 文本（逐字搬迁）；标定结果沿用，CI 复验仍为发布前置 |
| 尚未完成（如实） | — | 生产部署/迁移、CI 复验（需推送）、全栈 e2e 于最终候选的复跑、X07 终判（验收人） |

## 运行时（§5.7）

- 送审门禁全部在 **Node v22.23.4（nvm）＋corepack pnpm@11.11.0** 下执行（本轮总指挥命令均回显 node -v）。预检（22.17.1）结果不复用为冻结环境证据；22.23.4 已于 2026-11-07 安装并设 default。
