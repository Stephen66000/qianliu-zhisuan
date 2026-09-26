# 资金账本 V1.5 最终候选证据冻结（2026-09-26）

## 候选锚

| 项 | 值 |
|---|---|
| 分支 | `codex/provider-finance-main-integration-20260925` |
| code HEAD | `330fc16dfc2c9546f3e9d7655a4df67f18f811e0` |
| code tree | `e5e4da9df60d69b3191533f8cd928e938d873664` |
| main 基线 | `13890f70aac8c52b5ab0e0705c899a6cdb442762`（当前候选祖先） |
| 前序基线（bc44371） | `bc44371fa06e7b16b94c507a6f1c4c56ae8f2e50` |

## 330fc16 相对 bc44371 的变更范围

仅修改 11 个测试/夹具文件（`packages/database/src/__tests-integration__/`），
**零产品代码、零迁移实现、零门禁改动**。内容为 F-P2-6 合同夹具对齐与
迁移清单断言扩展至 0083 迁移头（详见提交信息）。

## 定向复验结果（同一候选 HEAD bc44371 → 330fc16 范围，全部 exit 0）

- **Database**：10 files / 101 tests，exit 0（`pf-v15-bc44371-fix-database-10-final3.log`）
- **Control API**：6 files / 57 tests，exit 0（`pf-v15-bc44371-resume-control-api-6.log`）
- **Web**：86 files / 552 tests，exit 0（`pf-v15-bc44371-resume-web.log`）

## 昨日单次 pnpm test 的 exit 1（如实保留）

2026-09-25 单次全量 `corepack pnpm@11.11.0 test`
（`pf-v15-bc44371-workbuddy-fulltest-final.log`）**最终退出码为 1，非 0**。
根因：Database 与 Control API 阶段执行时 Docker Desktop 不可用，
Testcontainers 报 `Could not find a working container runtime strategy`，
导致 55+5 个文件级失败；另有 w18-dashboard-usage 2 例断言失败发生于
Docker 恢复竞态窗口。**不得将该次命令记录为 exit 0。**

原始全量运行中的全部缺口，已由同一候选范围的上述分段复验覆盖通过。

## 未重复运行的证据沿用

其他包（config/contracts/domain/testing/observability/provider-adapters）、
Gateway（44 files 全过）、Worker（22 files / 102 tests 全过）、
百万行 `usage-aggregate-migration-capacity`、`project-allocation-close`、
W20 等均沿用同一候选此前已经通过的证据，本轮没有重复运行。

## 独立复核结论

Codex 增量独立复核未发现新 P0/P1，**V1.5 本地结论为 PASS**（仅适用于本地
候选 330fc16）。

## 授权边界

部署、生产迁移、真实金额录入和生产激活**均未授权**。本结论不构成推送、
合并、服务器部署、生产数据库迁移、真实金额录入或生产资金激活授权。

## 归档日志 SHA256（由复制后真实文件计算）

见同目录 `sha256.txt`。
