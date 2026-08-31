# 仟流智算本地仓库清理清单（2026-08-31）

本清单是只读审查结论，不授权删除、重置、移动、远端分支删除或部署。任何实际清理都必须在对应救援分支已推送并核验后分阶段执行。

## 1. 审查基线

- GitHub 主线：`origin/main` / `v2.3` / `bfbcae312b90e0ac98b6ff765645715d3336e60e`
- 当前本地主目录：`/Users/mac/Projects/仟流智算`
- 当前本地 `main`：`7e30840`，相对 `origin/main` 为 ahead 2 / behind 62
- 主目录大小：约 584MB，其中根 `node_modules` 约 415MB、`参考/` 约 73MB、`.git` 约 64MB
- Worktree：27 个登记记录；19 个目录存在；9 个记录可 prune
- 现存 Worktree 总体积：约 7.51GiB；14 个 clean Worktree 约 5.27GiB；5 个 dirty Worktree 约 2.24GiB
- 本地分支：40；其中 22 个已被 `origin/main` 包含
- 远端分支：23；Tag：7

## 2. 必须保留

以下是产品仓库的日常主体，不进入本地清理范围：

- `apps/`
- `packages/`
- `deploy/`
- `scripts/`
- `.github/`
- 数据库迁移、生产部署合同、自动化测试
- `README.md`、`.env.example`、工作区配置和锁文件
- 7 个版本 Tag
- Mac Mini 上的发布目录、`.env`、数据库、备份与 FRP 覆盖（不属于本次本地清理对象）

## 3. 已救援，远端核验后可从旧主目录移除

### 3.1 唯一历史资料

分支：`codex/local-history-rescue-20260831`

- 106 个此前从未进入任何可达 Git 引用的文件已归档。
- 加上归档说明和本清单后，由 Git Commit 提供内容哈希与历史追溯。
- 原主目录 117 个未跟踪文件的归属：106 个已归档、8 个已存在于其他 Git 引用、3 个为字节完全相同的重复副本。

重复副本候选：

- `V3/Evidence/Production-Release/20260806-pool033/rollback-to-029030-粘贴版.sh`
- `V3/Evidence/Production-Release/20260806-pool033/run-release-粘贴版.txt`
- `V3/Evidence/Production-Release/20260807-pool031035/run-release-粘贴版.sh`

### 3.2 零余额状态修复

分支：`codex/resource-status-rescue-v23`

- 已把仍有价值的唯一行为移植到 v2.3：API 当前余额或 Coding Plan 剩余额明确小于等于 0 时，资源列表、首页和用量总览展示为 `EXHAUSTED`。
- 不改数据库状态机，不改变 Gateway 准入。
- 原主目录中旧 Dashboard、Resources、Provider 路由和数据库投影修改，在该分支通过后不再作为独立候选保留。

## 4. 需要迁移或刷新，不应直接删除

- `WorkBuddy接入仟流智算使用教程.md`：本地 `ql-*` 别名修改有价值，但模型清单仍停在 GLM-5.2；应按 GLM-5.3 / GLM-5.3-Flash 重新核验后单独提交。
- `_knowledge_base/`：从产品仓库移到知识资料库；历史归档分支已保存其中的唯一文件。
- `design/logo-concepts/`：移到设计资产目录或独立资料库。
- `仟流智算商业化-圆桌完整对话-20260802.md`：移到内容/商业资料目录。
- `IDE1.5-Stage01-02方案文档审核报告-20260804.md`：移回 IDE 项目资料目录。
- V3/V4 历史方案、PoC、Evidence、原型：保留 Git 归档，但不继续铺在日常产品工作区。
- `_quarantine/`：已经受 Git 保护；若要从当前主线移除，应通过单独文档清理 Commit，不做本地直接删除。
- `.zcode/`：属于工具计划记录，不是产品运行文件；如仍需追溯，移到工具资料目录后再清理。

## 5. 外部参考源码

`.gitignore` 已明确声明 `参考/` 不应复制进产品目录。

- `参考/TokenHub`
  - 来源：`https://github.com/astaxie/TokenHub.git`
  - 当前 Commit：`1f4e7fe2bf25084f1a525e3ba2392be1e6bc49d2`
  - 工作区 clean，可按 Commit 重新克隆；记录完成后可移出产品目录。
- `参考/sub2api-main`
  - 来源：`https://github.com/Wei-Shaw/sub2api.git`
  - 当前目录缺少 `.git` 元数据
  - 全文件清单 SHA-256：`1d8458bc354285f8950eba59751522334b6cc22e22cf39ccee97ced2d6a6cfda`
  - 应先移到外部源码资料区；不要在没有第二份副本时直接删除。

## 6. 可重新生成的清理候选

以下内容不构成产品源事实；实际删除前应确认当前没有本地开发进程依赖：

- 根目录及非活动 Worktree 的 `node_modules/`
- `dist/`、`build/`
- `coverage/`
- `reports/` 中的测试/Mutation 生成物
- `playwright-report/`、`test-results/`
- `*.tsbuildinfo`
- `.DS_Store`
- 已有 README/result/checks 覆盖的临时 `*.log`

清除根 `node_modules` 约释放 415MB，但下次本地开发需要重新执行锁定版本的依赖安装。

## 7. Worktree 清理候选

### 7.1 可 prune 的 9 个记录

- `/private/tmp/qianliu-pool029`
- `/private/tmp/qianliu-pool042`
- `/private/tmp/qianliu-pool045-hotfix`
- `/private/tmp/qianliu-pool046`
- `/private/tmp/qianliu-prod-integration`
- `/private/tmp/qianliu-v1-final-audit`
- `/Users/mac/.codex-switcher/shared/.codex/worktrees/3f3f/仟流智算`
- `/Users/mac/.codex-switcher/shared/.codex/worktrees/708d/仟流智算`
- `/Users/mac/.codex-switcher/shared/.codex/worktrees/p013/仟流智算`

### 7.2 当前 clean、可在分支/Commit 核验后移除 Checkout 的 14 个 Worktree

- `/private/tmp/qianliu-history-rescue.3iUMEX`
- `/private/tmp/qianliu-reasoning-compat`
- `/private/tmp/qianliu-resource-rescue.u0SByS`
- `/private/tmp/qianliu-rule-v23.ldSHnt`
- `/Users/mac/.codex-switcher/shared/.codex/worktrees/708d/仟流智算`
- `/Users/mac/.codex/worktrees/4733/仟流智算`
- `/Users/mac/.codex/worktrees/b4fc/仟流智算`
- `/Users/mac/.codex/worktrees/deepseek-error/仟流智算`
- `/Users/mac/.codex/worktrees/final-qianliu`
- `/Users/mac/.codex/worktrees/pool20-045-047/仟流智算`
- `/Users/mac/.codex/worktrees/pool20-049/仟流智算`
- `/Users/mac/.codex/worktrees/qianliu-model-discovery-md-20260825`
- `/Users/mac/.codex/worktrees/resource-tabs/仟流智算`
- `/Users/mac/Projects/仟流智算-1.0-review`

删除 clean Worktree Checkout 不等于删除分支；预计最多释放约 5.27GiB。仍需逐个确认没有运行中的进程引用这些路径。

### 7.3 当前 dirty，禁止直接删除的 5 个 Worktree

- `/Users/mac/Projects/仟流智算`：49 个状态项；本清单的主要救援对象。
- `/Users/mac/.codex/worktrees/3fa4/仟流智算`：其 113 个工作文件与主目录副本一致，另有一个停在 `POOL20-036` 的旧问题蓄水池版本。
- `/Users/mac/.codex/worktrees/df73/仟流智算`：其 113 个工作文件与主目录副本一致，另有同一个旧问题蓄水池版本。
- `/Users/mac/.codex/worktrees/qianliu-ide-use-013-prod/仟流智算`：调度错误结构已由新版 `origin/main` 实现；工作文件是较旧版本。
- `/Users/mac/.codex/worktrees/qianliu-ide-use-013/仟流智算`：同类旧调度实现；当前主线已有更新后的实现与测试。

这些 dirty Worktree 只有在救援分支远端核验、文件级差异再次确认后，才可放弃旧现场。

## 8. 本地分支候选

以下 22 个本地分支已被 `origin/main` 包含；移除相关 Worktree 后可考虑删除本地分支引用，但本清单不授权执行：

- `codex/final-production-release`
- `codex/ide-use-013-017`
- `codex/ide-use-013-prod`
- `codex/model-discovery-md-20260825`
- `codex/pool-039`
- `codex/pool-039-043-prod-integration`
- `codex/pool-040-041`
- `codex/pool-042-fix`
- `codex/pool-043`
- `codex/pool-046-zhipu-window`
- `codex/pool20-045-047`
- `codex/pool20-052-batch-additive`
- `codex/reasoning-field-compat-20260831`
- `codex/release-v2.0-w20-11`
- `codex/resource-tabs-usage-overview`
- `codex/runtime-assurance-pool-014-integration`
- `codex/v1-final-audit`
- `codex/v2.1-test-fixes-r2`
- `codex/v2.2-test-fixes`
- `feat/weekday-picker`
- `fix/pool033-refresh-key-models-whitelist`
- `release/2.1`

远端分支和版本 Tag 不在本地清理阶段删除。

## 9. 推荐执行顺序

1. 推送并核验两个救援分支。
2. prune 9 个失效 Worktree 记录。
3. 删除已核验的 clean Worktree Checkout，保留尚需追溯的分支引用。
4. 逐个关闭 5 个 dirty Worktree；第一次出现不一致立即停止。
5. 把外部源码和非产品资料移出产品目录。
6. 清理生成物和非活动依赖目录。
7. 从 `origin/main` 新建干净 Clone，验证后替换当前本地主目录。
8. 另开文档结构 Commit，讨论是否从主线移出 V3、`_quarantine` 和旧 Evidence。

最终目标是：一个跟随 GitHub `main` 的日常产品目录、一个必要的当前功能 Worktree、一个不日常 Checkout 的历史归档分支。
