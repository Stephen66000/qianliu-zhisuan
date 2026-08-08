# POOL-029 / POOL-030 集成回归证据

- 日期：2026-08-04（Asia/Shanghai）
- 集成基线：`486c8d8290d8cfa77923a6ad10acdee2e50f120d`
- POOL-029 集成提交：`2ea490b`（候选提交 `a6f8bc7`）
- POOL-030 集成提交：`9b8bd5e`（候选提交 `dd33eb5`）
- 当前结论：按 POOL-029 → POOL-030 顺序集成并发布 Mac Mini；全项目回归、质量门禁、数据库迁移、容器健康与公网最小冒烟 PASS。生产真实业务验收仍待执行，不提前关闭问题。

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

## Mac Mini 生产发布（2026-08-04）

- 发布脚本提交：`08e104f0ecebe847794bf7a562aaaa26918a0a1f`；脚本从私有 GitHub 锁定拉取已回归候选 `9da9ab12c42b1168485592ef75a5a4c35ca06fec`。
- Release：`/Users/stephen/releases/qianliu-zhisuan-pool029030-9da9ab1-20260804`。
- 发布前数据库备份：`/Users/stephen/backups/qianliu-zhisuan/pre-pool029030-20260804-225105.dump`；SHA-256：`6c65212e2d5315369a9d2f910da39fb129b17180a157b8d0f09eff60a0ba5691`；备份目录校验通过。
- 数据库从 `0037_client_identity` 升级到 `0038_employee_model_authorization_rule`；迁移执行 1/1 PASS。
- 生产显式配置 `GATEWAY_KIMI_FIRST_BYTE_TIMEOUT_MS=120000`；发布脚本已在 Gateway 容器内复核实际环境值。
- Control API、Gateway、Web 均为 HTTP 200，Worker `healthy`；七个生产容器均运行且 RestartCount=0，当前 Release 工作目录校验通过。
- 数据库最小冒烟：`principal_model_manual_authorization=12`、有效 Key `=5`。
- 外部独立复核：`https://gw.qianliuai.com/health`、`https://ic.qianliuai.com/login`、`https://ic.qianliuai.com/api/health` 均返回 HTTP 200。
- POOL-029 管理后台生产闭环已执行：创建 `POOL-029生产验收-20260804 v1`，选择于滔、曹磊与 `qianliu-deepseek`；校验显示 `2 人 × 1 模型 = 2 项`、`新增 0 / 保留 2 / 撤销 0`，草稿、校验、发布、停用状态均成功。
- 停用后两名员工原手工 Key 权限和 `50,000,000` DeepSeek 有效 Grant 均保留；规则生成的 `1,000,000` Grant 明确显示“已停用”，没有覆盖或撤销手工基线。
- 双员工真实 WorkBuddy 请求与 Kimi 长输入因非工作时间暂缓，规则已停用，生产权限恢复原基线；上班后新建版本再继续，不以后台闭环代替真实业务验收。
- 发布脚本最终输出 `COMPLETE`，未触发应用回滚。当前仍需按验收标准完成双员工授权／越权／撤权／账本与真实 Kimi 长输入，完成后方可关闭 POOL-029/030。
