# 功能、安全与恢复复核

- 审核时间：2026-08-01 19:42 +08:00
- 风险等级：HIGH
- 基线提交：`425d16fc6de403991967fd5033922c278fb8368c`
- 候选对象锁：`01-candidate-lock.sha256`
- 对象锁摘要：`7f266b1928d9212d18df20f9883920f7e93d254281309f3b63dfe29752d5d348`
- 本地代码整改：通过。
- 正式环境部署：2026-08-01 已完成，服务与安全冒烟通过；四存储 canary 和实际回退演练仍待补充，不能据此写成完整发布审核通过。

## 已验证

| 检查 | 结果 | Evidence |
| --- | --- | --- |
| 全仓单元/集成测试 | 通过 | 514 项测试通过；TypeScript、ESLint、Build 均通过。 |
| Web E2E | 通过 | 一次性 PostgreSQL、独立 18788/15173 端口，Playwright 22/22。 |
| Gateway Codex E2E | 通过 | Codex CLI 退出码 0；上游调用 2、请求 2、账本事务 2。 |
| 登录与浏览器安全 | 通过 | 登录限速有界且过期回收；生产 Origin 白名单和跨站写请求拦截有单元/集成测试。 |
| 服务恢复 | 通过（本地） | Control API/Gateway 收到 SIGTERM/SIGINT 后关闭 Fastify 与数据库；Compose 预留 20 秒。 |
| 生产依赖 | 通过门禁 | OpenTelemetry 修到 2.8.0；无未豁免 moderate/critical。React Router RSC-only high 例外至 2026-09-01。 |
| Secret/源码泄漏 | 通过 | seed-admin 不再使用 argv/输出密码；生产 Source Map 关闭。 |
| Mac Mini 正式部署 | 通过 | 活跃目录为 `qianliu-zhisuan-v0.3.0-7f266b19-20260801`；Control API、Gateway、Worker、Web、PostgreSQL、Redis、Caddy 均启动并通过健康检查。 |
| 生产 Origin 校验 | 通过 | `WEB_ORIGIN=http://localhost:8080,http://127.0.0.1:8080`；合法来源返回 200，恶意跨域写请求返回 403。 |
| 生产回退准备 | 通过（未实操回退） | 旧发布目录和五个旧业务镜像标签保留；数据库与生产 `.env` 已备份至 `20260801-2108-7f266b19`。 |

## 未伪装为通过的发布前置

`evidence:canary` 当前只实际扫描内存日志，结果为 `logs=0`；PostgreSQL、Redis、Trace 明确返回 `null`。本次部署已验证 PostgreSQL/Redis 可用性，但尚未以唯一业务请求完成四存储泄漏扫描，因此仍需补充该证据，不能继承历史记录。

本轮未修改数据库 Schema、计费算法或额度语义。Compose 迁移服务按既有流程执行并成功退出，没有新增 Schema 迁移；正式服务已更新并重启。
