# POOL-029 / POOL-030 集成回归证据

- 日期：2026-08-04（Asia/Shanghai）
- 集成基线：`486c8d8290d8cfa77923a6ad10acdee2e50f120d`
- POOL-029 集成提交：`2ea490b`（候选提交 `a6f8bc7`）
- POOL-030 集成提交：`9b8bd5e`（候选提交 `dd33eb5`）
- 当前结论：按 POOL-029 → POOL-030 顺序集成完成，全项目回归与质量门禁 PASS；尚未推送、部署，生产业务验收待 Mac Mini 发布后执行。

## 集成处理

1. 先锁定并校验 POOL-029 候选清单，41 个文件哈希、文件集合及 `git diff --check` 一致后提交。
2. 对 POOL-030 最新候选完成独立最终复核，确认生产 Caller 装配、四层超时语义、首字节超时不切换及账本边界，无遗留 P0–P3；27 个文件哈希与候选集合一致后提交。
3. 主仓既有未提交内容在集成前单独保护；两项候选按顺序 cherry-pick。冲突只发生在蓄水池和组合质量门禁配置，解决时同时保留 POOL-029 与 POOL-030 的覆盖率、变异测试及状态记录。

## 全项目回归

- Web：75/75 PASS。
- Config：5/5 PASS。
- Contracts：3/3 PASS。
- Domain：158/158 PASS。
- Observability：9/9 PASS。
- Provider Adapter：88/88 PASS。
- Database：34/34 PASS。
- Control API：120/120 PASS。
- Gateway：140/140 PASS；包含 Responses、Messages、Chat、工具调用和 60.35 秒连续 SSE。
- Worker：10/10 PASS。
- Chromium 真实 Web E2E：26/26 PASS；包含 POOL-029 草稿、校验、发布、历史和停用闭环。

说明：首次递归回归中 Control API 的并行 Testcontainers 出现一次 `Connection terminated unexpectedly`，该套件未进入断言。改为单文件串行后 16 个文件、120/120 全部通过，属于临时测试数据库并发竞争，不是业务失败。

## 质量门禁

- 全工作区 TypeScript、ESLint、生产构建：PASS。
- POOL-029 Node 增量覆盖 51/51、Web 增量覆盖 5/5：PASS。
- POOL-030 Gateway 增量覆盖 22/22、Provider 增量覆盖 2/2，四项指标均 100%。
- 覆盖率 ratchet：9 个 scope 无回退。
- 变异测试：POOL-029 18/18、POOL-030 Gateway 67/67、Provider 3/3，关键变异全部 killed；全局 disposition gate PASS。
- 架构：191 个生产源码文件无运行时循环依赖。
- 源文件体量门禁：PASS。
- 重复率：行 0.72%、Token 0.53%，低于 5% 阈值。
- 生产依赖审计：命令 PASS；1 个高危项命中既有批准忽略清单。
- 许可证门禁、证据 Canary、`git diff --check`：PASS。

## 发布边界

1. 推送前恢复并保留主仓原有未提交内容，不纳入 POOL-029/030 集成提交。
2. Mac Mini 发布前必须生成数据库备份并校验 SHA-256。
3. 执行迁移 `0038_employee_model_authorization_rule`，Control API、Gateway、Web 同批发布。
4. 生产环境显式配置 `GATEWAY_KIMI_FIRST_BYTE_TIMEOUT_MS=120000`。
5. 发布后完成公网健康、容器重启计数、关键日志、双员工授权／越权／撤权／账本以及 Kimi 短请求和超过 30 秒长输入验收，再关闭问题。
