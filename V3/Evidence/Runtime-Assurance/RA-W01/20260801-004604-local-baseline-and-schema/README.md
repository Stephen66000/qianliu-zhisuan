# RA-W01 本地基线与 Schema Evidence

| 项目 | 结果 |
| --- | --- |
| 工作包 | `RA-W01` |
| 执行窗口 | 2026-08-01 00:46～01:15（Asia/Shanghai） |
| 事实源 | `/Users/mac/Projects/仟流智算` |
| 结果 | `PASS / DONE` |
| Mac Mini | 未连接、未部署、未修改 |
| Git 写操作 | 未提交、未切分支、未合并、未推送 |

## 1. 安全时间点

- 开工前源码清单：`01-main-source-baseline.sha256`，224 项；
- 开工前迁移清单：`02-main-migration-baseline.sha256`，20 项（`0000～0019`）；
- 开工前工作树状态：`03-main-working-tree-status.txt`；
- 项目外安全副本：`/Users/mac/Projects/仟流智算-RA-W01-safety-20260801-004604/`；
- 安全副本含 21 项 SHA-256 清单，只复制开工前已有修改／未跟踪文件；排除 `.env`、Evidence 和 Secret 内容。

## 2. `0020～0029` 来源与处置

本机已部署成果的可验证来源为：

- 目录：`/Users/mac/.codex-switcher/shared/.codex/worktrees/43a4/仟流智算`；
- 基线 commit：`e1006dc`；
- 该工作树还包含已部署 `0029_provider_quota_auto_calculation.js` 的未提交成果；
- `V3/仟流智算-stage-state-v0.3.yaml` 与既有 POOL Evidence 明确记录：发布来自该 integration 工作树，生产迁移达到 `0029`，不是从 main 或 `2e63` 发布。

同步结果：

- `0020～0028` 从 `e1006dc` 对应源码链找回；
- `0029_provider_quota_auto_calculation.js` 从 43a4 已部署工作树找回；
- 基线 commit 与 43a4 的 `apps/`、`packages/` 相关差异为 116 个文件，另纳入该工作树 0029 的必要未提交源码／测试／Logo；
- `04-source-candidate.sha256` 保存 264 项比对范围。同步后无缺失；构建产物、测试报告以及本次 RA-W01 新改文件不要求与来源副本保持相同。

本机曾同时发现另一个未跟踪候选 `0029_gateway_stream_resilience.js`。它属于另一工作树的后续流式韧性实验，名称、内容和已部署 Evidence 都与生产所记 `0029` 不符，因此不作为事实源，也未与额度迁移拼接。

## 3. 文件级冲突保护

开工前已有 9 个已修改文件和若干未跟踪文件。同步时逐文件判断：

- `apps/gateway/src/main.ts`、`apps/gateway/src/pipeline/real-pipeline.ts`、`apps/web/Dockerfile`、`apps/web/src/api/client.ts`、`apps/web/vite.config.ts`：已部署源码完整包含本地主干改动，采用其超集；
- `packages/contracts/src/index.ts`：采用已部署合同，同时保留本地既有 `responseBody?: unknown` 兼容字段，并标明后续 RA-W04 再收敛；
- `apps/gateway/src/pipeline/http-caller.ts`：本地既有未跟踪实现原样保留；
- 官方 Logo 为唯一二进制同步项；
- 未覆盖或丢弃任何开工前用户文件，未做无关重构。

## 4. RA-W01 新增设计与实现

- `V3/ADR-RUNTIME-ASSURANCE-FOUNDATION.md`：接受双表规则版本模型；
- `0030_runtime_assurance_foundation.js`：新增人员、规则、事件、企微 endpoint 和 delivery 七表，并补充主体／告警可空关联；
- 七张新表均没有 `tenant_id`、`enterprise_id`；系统只允许一条有效企微自建应用 endpoint；
- `packages/domain/src/runtime-assurance.ts`：六态 Shadow 迁移建模和统一类型；普通 429、5xx、超时、网络失败不自动硬隔离；
- `packages/config/src/index.ts`：`OFF／OBSERVE／ENFORCE`，默认 `OBSERVE`；企微通知默认 `false` 且严格解析；
- 未修改运行保障熔断业务热路径，未实现 RA-W02 或后续 API／UI／Worker／企微发送。

## 5. Schema 验证

- PostgreSQL 17 本地临时测试库；执行后容器已删除；
- 空库从 `0000` 升级到 `0030`：31 个迁移全部成功；
- 最新 Schema：39 张业务／迁移表、516 列；
- 七张新表中的 `tenant_id`／`enterprise_id` 数量：0；
- 回滚 `0030` 成功；重新升级 `0030` 成功；
- 归一化 columns／constraints／indexes 指纹在回滚前后均为 `fb838cb452a93565a8ad2f1aefc09085`；
- 重升后的 schema-only SHA-256：`26ba251e19fcc80f3911c83196451e8d8cbd6e17c755e8800a7a06fe4a77f92f`。

## 6. 质量门禁

最终门禁使用 Node `v22.17.1`、pnpm `11.11.0`：

- typecheck：PASS；
- lint：PASS；
- 单元测试：PASS；
- 集成测试：PASS。Provider 3、Database 21、Control API 70、Gateway 103；
- build：PASS，Web 1745 modules；
- 本地隔离 PostgreSQL + Chromium E2E：21/21 PASS；使用 18788／15173 备用端口，未停止或复用本机已有 8788 服务。

递归并发集成测试曾出现一次 Testcontainers 停库时的 PostgreSQL `57P01` 未处理事件；所有断言均已通过。随后数据库包单独复跑通过，并用 `--workspace-concurrency=1` 完整复跑所有集成包，结果稳定通过。未为此修改业务代码。

完整命令与结果摘要见 `09-test-results.md`。

## 7. 风险与结论

- 既有 Gateway 仍可能按连续 429／5xx 技术失败进入硬隔离；RA-W01 只交付安全 Shadow 迁移模型，热路径替换属于 RA-W04，事件／恢复属于 RA-W05B；
- `principal.person_id`、`owner_person_id` 为可空加法列，避免 RA-W02 前破坏既有写路径；
- 企微凭证、可见范围和 userid 不属于 RA-W01 门禁，不阻塞本工作包；后续只允许按成员 userid 定向发送；
- 当前没有必须由 Owner 决定的 RA-W01 阻塞。

结论：RA-W01 的 Local First、安全同步、迁移链、ADR、配置 Schema、六态方案、类型、回滚与全量本地门禁均已完成；RA-W02 未开始。
