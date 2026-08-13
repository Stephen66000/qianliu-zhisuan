# Git、工作区与运行时基线

## 隔离 worktree

| 项 | 值 |
| --- | --- |
| HEAD／tree | `6fc1bec2a211c0d9c399400076cc56720f5c1815`／`198b071b41c052080836fdaac4f399c6c69e7aac` |
| 分支／upstream | detached HEAD／无 upstream |
| 起点 dirty | staged 0、tracked modified 0、untracked 0 |
| 本地 refs | `origin/main`、`codex/pool-046-zhipu-window` 均为 `6fc1bec2…` |
| 远端只读核验 | 2026-08-12 22:18，远端 `HEAD/main/codex/pool-046-zhipu-window` 均为 `6fc1bec2…` |
| 网络动作 | 仅 `git ls-remote`；未 fetch、push 或写远端 |

工作树建立后没有创建分支。本轮没有 branch／commit 授权，故保留 detached HEAD，并通过完整 commit＋tree 锁定对象。

## 原工作区（起点只读核验）

| 项 | 值 |
| --- | --- |
| 路径 | `/Users/mac/Projects/仟流智算` |
| HEAD／tree | `c04df1f7d2ea84f2cdbd2bddfe2f586c7ee451d8`／`0977fccf5ab796fa10e624a09a6fb51f1faa35aa` |
| 分支／upstream | `main`／`origin/main`，`+0/-17` |
| tracked 修改 | `V3/仟流智算-测试问题蓄水池.md`、`WorkBuddy接入仟流智算使用教程.md` |
| untracked | 109；其中 `V4/` 69、`_knowledge_base/` 20、`V3/` 14、`design/` 4、根文档 2 |
| 冻结 V4 文件 | 七份输入均为原工作区 untracked，隔离 worktree 起点不存在 |

所有内容按用户资产处理。起点只读核验后，仅根据 W20-01 授权与 `PC-20260812-04` 决策回写原工作区 V4 权威合同、执行基线和进度图；修改前均核对 preimage SHA-256：执行基线 `95af4ffb…`、进度图 `b07be38d…`、Planning Change `2f1eec25…`、计划 `e380bd30…`、PRD `464336b7…`、TRD `9e102e19…`、AT `08d66999…`、原型 `66bbeca0…`。其他 tracked／untracked 用户内容未覆盖，也未执行 clean／reset／checkout／prune；原工作区不能作为干净 2.0 代码起点。

## 历史 Tag 与当前可用 1.0

```text
v1.0.0-final tag object 099666e2920709b135f8adf88272703134fcd4c7
v1.0.0-final commit     b3fb74b387ef61734d949be2e97fab7904bca959
v1.0.0-final tree       68719129f9e9ee6a0ebfa56ab371cc42912fb34c
tag...HEAD               7 / 8
merge-base               7ec225ba11068d4b40b92d3a9cc9c01a1e23d13b
```

最新仓库生产 Evidence 绑定 `ffd2b31c…`，记录服务发布及数据库 `0044→0045`。`git diff ffd2b31..6fc1bec -- apps packages deploy package.json pnpm-lock.yaml pnpm-workspace.yaml .env.example` 无输出，证明当前 HEAD 的产品运行范围与该已发布候选一致；当前 HEAD 额外包含 V3 Evidence、问题池及原型文档收口。

## 运行时／依赖

| 对象 | 核验值 |
| --- | --- |
| Node | `v22.17.1`，满足 `>=22.17 <23` |
| pnpm | 工程固定 `11.11.0`；所有工程命令均经 Corepack |
| TypeScript／Vitest／ESLint | `5.9.3`／`3.2.4`／`9.18.0` |
| Docker／Compose | `28.0.1`／`2.33.1` |
| psql | 本机客户端 `16.14`，不冒充目标 PG17 |
| PG／Redis Testcontainers | PG17／Redis8 均锁 digest |
| 供应链缺口 | 四个应用 Dockerfile 的 Node、CI PostgreSQL、Nginx／Caddy 仍存在只锁 tag 的既有缺口 |

只读检查：`git fsck --connectivity-only`、`git diff --check`、`QIANLIU_ENV_FILE=../.env.example docker compose -f deploy/compose.yaml config --quiet` 均 exit 0。测试产生的一次性 Testcontainers 已由 Ryuk 清理；未删除或停止用户原有容器。
