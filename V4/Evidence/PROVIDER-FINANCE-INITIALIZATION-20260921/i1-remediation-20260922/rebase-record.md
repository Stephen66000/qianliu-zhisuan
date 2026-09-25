# 候选 rebase 记录（F-P1-7 处置）— 2026-09-22

> 目的：消除候选继承 kimi model-discovery 的 FAIL 代码（I1 复核报告 F-P1-7）。
> 范围：仅改写本 worktree 的本地未推送历史；未 push、未合并、未部署、未触碰生产。

## 1. 处置方式

将本候选自有的 18 个提交从原基线 `ca533e3d`（kimi 分支未修复 tip 的状态）重放到
kimi 已完成 6 项 P1 修复的提交 `5160002` 之上：

```bash
git rebase --onto 5160002 ca533e3d codex/provider-finance-initialization-20260921
```

| 项 | 值 |
|---|---|
| 旧基线（本候选切出点） | `ca533e3d790270f2a33b15de73e3417ab8656b76` |
| 新基线（kimi 修复 tip） | `5160002bdd0c4c6a4612fcb7060f45f9d4390cc2` |
| 重放提交数 | 18（`ca533e3d..ae202e1`） |
| 冲突数 | **0** |
| 旧 HEAD | `ae202e1aac9ea61de85a52850ba0fa004a8723b6` |
| 新 HEAD | `94482f06e5ac69a80357b6e17b9786f7690265c4` |
| 回退分支 | `backup/finance-pre-i1-rebase` → `ae202e1` |

## 2. 为什么选 5160002 而不是 kimi 分支当前 tip

核验时点：kimi 分支 tip 已推进到 `ebc578b`（`fc8becd` 报告 → `3ac09ff` P2/P3 收尾轮 → `ebc578b` 报告）。
三个候选 base 的对照：

| 候选 base | 6 项 P1 | 13 项 P2 | 迁移编号 | 与本候选文件重叠 | 结论 |
|---|---|---|---|---|---|
| `ca533e3d`（原基线） | 全部未修复 | 未修复 | 0076/0077 | — | 即 F-P1-7 所指的 FAIL 状态 |
| `5160002`（**采用**） | 全部关闭 | 未关闭（不在本次关闭范围） | 0076/0077 | **0 个文件** | 修复面最小、无冲突、无编号冲突 |
| `ebc578b`（kimi 当前 tip） | 全部关闭 | 10/13 关闭 | 新增 **0078** | 2 个文件（`packages/database/src/index.ts`、`apps/worker/src/provider-operating-sync/runner.ts`） | 会撞迁移编号并引入 rebase 冲突 |

选择 `5160002` 的理由：

1. **修复面最小**：只引入 F-P1-7 点名要求清除的 6 项 P1 修复，不额外引入 `3ac09ff`
   这个 2026-09-22 16:49 刚提交、尚无任何审核覆盖的 P2/P3 收尾轮（+1078/−501 行、16 个文件）。
2. **零冲突**：本候选 18 个提交与 `5160002` 的 15 个变更文件**文件集零重叠**，rebase 无冲突。
3. **无迁移编号冲突**：`5160002` 的迁移头为 `0077_provider_model_probe_run_identity.js`，
   kimi 的 `0078_provider_model_probe_enum_checks.js` 是后来 `3ac09ff` 才引入的。
   因此本候选的 `0078_provider_finance_activation.js` / `0079_provider_finance_candidate_draft.js`
   保持有效，**迁移改号授权（已获批准）本轮未动用**。
4. **门禁违规随之归零**：kimi tip 侧 3 个超限文件在 `5160002` 已合规
   （`model-discovery-routes.ts` 392、`ResourceModelDiscovery.tsx` 687 ≤ 基线 723、
   `model-discovery.ts` 408 ≤ 基线 484），F-P1-5 剩余 3 项违规自动清零。

> 需要切换到 `ebc578b` 时的追加动作：迁移改号 0078→0079、0079→0080（影响面 29 处引用
> + 6 份 Evidence 文本），并解决上述 2 个文件的冲突。

## 3. rebase 后必须重做的动作（证据作废清单）

WP08 报告（`7c2e5ca`，即旧 `5ac2881`）已自行声明：任何 rebase 都会使候选镜像
`qianliu-candidate/*:<旧 short SHA>` 失效。本记录确认该项作废，需重做：

1. 旧候选镜像/指纹清单作废，以新 HEAD `94482f0` 重建（`wp08-fingerprint/`）。
2. 全部门禁以新 HEAD 复跑：typecheck / lint / 单测 / 集成 / 覆盖率 ratchet / 体积 / 架构 / 许可证 / 重复度。
3. 旧提交号在 I1 报告与各 WP 报告中的引用一并登记映射（见同目录 `commit-sha-mapping-post-rebase.md`）。
4. PFA-08/09 演练（双端停写、激活前静默）以新 HEAD 重跑。
