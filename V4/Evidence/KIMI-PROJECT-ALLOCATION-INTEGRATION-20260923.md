# Kimi + 项目归集整合记录（2026-09-23）

## 对象与原因

- GitHub `main` 整合前：`56fc2ada7a2073461757c156e0901942bb20c682`，含项目归集，但不含 Kimi 修复。
- UAT 当前源码与 GitHub Kimi 分支：`d1c3984503cac6af656caa77b0e319fe023c5d50`。
- 两线共同祖先：`4a3d139346dfc21b37eab3783a16dd0aaa427242`。
- UAT PostgreSQL 的 `kysely_migration` 只读查询确认最近三条为 Kimi `0076_provider_model_probe`、`0077_provider_model_probe_run_identity`、`0078_provider_model_probe_enum_checks`；归集尚未执行。

整合从 `56fc2ad` 出发，合入 `d1c3984`。唯一文本冲突是 `credential-probe-migration.test.ts` 的回退阶梯；Kimi `0076–0078` 已在 UAT 执行，原名和迁移内容均保留。归集管理层与计算层从 `0076/0077` 顺延为 `0079_project_allocation_relations`、`0080_project_allocation_compute`，并同步更新受影响的迁移测试期望。历史 C3 审核文档不改写，以本记录说明当前发布迁移名。

合并后的架构检查发现两个原候选内的运行时依赖环：规则仓储与预览互相重导出、归集执行与发布互相引用版本常量。已改为从公共模块引用常量、由包入口直接导出预览，消除环且保持外部 API 与业务行为。`database/index.ts` 保持原 440 逻辑行例外基线，没有放宽质量门禁。

## 验证

- PG17：从 `0078_provider_model_probe_enum_checks` 且已有 Kimi 探针运行/明细证据的状态升级，`migrateToLatest` 仅执行归集 `0079/0080`；探针证据仍在，归集表已建立（新增专项测试 1/1）。
- 数据库迁移框架、Kimi 探针迁移、归集 foundation/compute/close/invariance：首轮 58/59，唯一失败为合并时重复写入三条回退断言；修正后该用例 1/1，专项计算/结账/升级路径 25/25。
- 历史迁移阶梯 6/6；Kimi 发现/凭证探针与归集 API 47/47。
- 根级 typecheck、lint、build 均 exit 0；架构检查无运行时环；source-size 检查 570 个生产文件通过，原门禁阈值未变。
- 所有实验使用本地独立 PG17 Testcontainer；未对 UAT 执行迁移、构建、重启或数据写入。

## 发布边界与下一条线

本记录仅证明合并候选的本地兼容性。UAT 运行容器不带 Git 提交标签，部署时须记录服务器源码提交、构建镜像 ID、替换后的容器 ID、数据库迁移头与 HTTP/关键业务路径核验。项目归集百万行生产规模性能仍未验收。

资金账本本地候选 `2928405` 尚未合入；其现有 `0078/0079` 与 UAT 已执行的 Kimi `0078` 及本候选归集 `0079/0080` 冲突。若后续纳入同一发布线，应从本整合结果接续，保留已执行的 Kimi 迁移名，并将资金账本未执行迁移顺延到 `0081/0082` 后重新验证，不在本轮提前执行资金激活。
