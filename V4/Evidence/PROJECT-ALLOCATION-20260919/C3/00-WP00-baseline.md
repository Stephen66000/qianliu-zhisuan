# WP00 基线与授权 — 候选 C3（v1.2 重启）

日期：2026-09-21。

## 1. 授权引用

用户 2026-09-21 授权（要点）：以修订后的 v1.2 计划为唯一输入；不续做 C1/C2、不修改主工作树与 `仟流智算-c2`；先只读确认主工作树实际 HEAD，从该提交创建全新 worktree `仟流智算-project-allocation-v12-20260921`（分支 `project-allocation/v12-restart-20260921`）；主工作树未跟踪的计划文件仅作输入复制；先关闭 3 P2 + 3 P3 再提交仅计划文档的 commit；随后从零重跑 WP00–WP07/R01，WP01 后做一次独立静态自审，无产品口径冲突或真实阻断则不停顿；全程本地分阶段 commit、不 push/不合并/不部署。

## 2. 基线

- 代码基线：**2b33719**（`codex/wecom-activation-release-20260911`，与用户现场观察一致；开工实测确认）。
- 计划提交：**052df0b**（仅计划文档，关闭 P2-1/2/3、P3-1/2/3）。
- worktree：`/Users/mac/Projects/仟流智算-project-allocation-v12-20260921`，创建时 `git status --porcelain` 为 0 行；主工作树 dirty 内容（213 项）未带入。
- 主工作树与 `仟流智算-c2` 全程只读；计划原文件在主工作树保持未跟踪未修改（复制后校验）。

## 3. 与前序核验基线（3407093，C2 证据基础）的关系

`git diff --name-only 3407093..2b33719` 于 src 范围仅 2 个目录导入相关文件（w20-directory.test.ts、directory/excel.ts）；归集承重文件（admin-permissions、month-lines、write-barrier、request-attribution-writer、kysely-ledger-tables、operating-bill-month 等）同字节，C2 WP01 的代码事实结论按文件等同性继承，并在 2b33719 上抽查承重行留痕（receipts/wp00-baseline-checks.txt）。

## 4. 基线关键事实（WP02+ 直接输入）

1. 迁移头：`0075_provider_resource_archive.js`；新迁移编号顺延（0076 起），down 阶梯测试届时扩链。
2. 阶梯测试：仅 pool048/runtime-admin-migrations 已含 0073；其余停在 0072（基线既有状态）。
3. 权限：12 模块 view/operate；`principals`＝使用主体、`billing`＝经营账单；无新权限实体（P2-2）。
4. 账本列：`upstream_attempt_id`（非空）、`api_cost_currency(CNY|USD)`、`api_cost numeric`、tokens bigint×4、`settled_at`；`account_at = finance.enabled ? settled_at : created_at`；北京自然月（+08:00）。
5. 账本新数据感知：无触发器/outbox；唯一同事务钩子为结算事务内 `markUsageAggregateDirtyForRequest`；经营账 DRAFT 读时聚合；任务框架先例 `directory_import_run`（租约/退避/FOR UPDATE SKIP LOCKED）。
6. `operating_bill_version` 无 DB 级不可变保护（仓储只插）；run 引用保护需自建 FK RESTRICT。
7. Docker 可用；集成测试每文件自起 postgres:17-alpine 容器。
8. 基线既有红（文件未变，继承 C2 实测）：standard-home ×4、pool042 ×1、control-api provider-finance ×1、gateway pool043-settlement ×2；w20-directory 企业排序 flaky。终局门禁时以基线/当前对照回执留痕。

## 5. 候选与证据

- 候选编号 **C3**（C1=无效草稿、C2=只读参考）。
- 证据目录：`V4/Evidence/PROJECT-ALLOCATION-20260919/C3/`；回执 `receipts/`。
- 主工作树现场处置：未修改、未清理；C1 文件原位保留。
