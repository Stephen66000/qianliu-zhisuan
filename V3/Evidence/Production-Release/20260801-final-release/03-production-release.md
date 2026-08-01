# 仟流智算首次生产发布与基础验收

- 日期：2026-08-01（Asia/Shanghai）
- 结果：**PASS**
- 版本：`v0.3.0`
- Git commit：`dd80e975ff6cc88e5dab3967479c299bc778b0ac`
- Release：`/Users/stephen/releases/qianliu-zhisuan-v0.3.0-dd80e975-20260801`
- 完成时间：`2026-08-01T16:59:55+08:00`

## 1. 发布与迁移

1. 发布前只读核对生产目标、旧 Release、容器、磁盘、环境变量存在性、数据库和公网健康。
2. 任何迁移前完成 PostgreSQL 备份，文件非空、可读且 `gzip -t` 通过；路径、大小、
   SHA-256 和回滚基线见 `02-preflight-access.md`。
3. 使用 `git archive` 从冻结 commit 生成候选包：
   `dd88ed205ca7ef7734ca29ce439ae8f1157390b81828b7b7b922438e30d263cc`。
4. Mac Mini 原生构建 `migrate / control-api / gateway / worker / web`，保留旧应用镜像标签。
5. 受控暂停 Caddy、Gateway、Control API 和 Web 写入口后，迁移器依次记录：
   `0029_provider_quota_auto_calculation` → `0030_runtime_assurance_foundation` →
   `0031_gateway_stream_resilience`，未跳号。
6. Schema 验证通过：`person`、运行保障规则/事件、通知端点/Outbox 表存在，
   `upstream_attempt.failure_layer` 存在，资源状态约束包含 `RATE_LIMITED`。

首次运行迁移时发现 Compose 的独立 `migrate` 镜像未纳入构建，旧镜像只识别到 0029。
脚本在迁移后断言处立即失败；数据库仍为 0029、没有服务写入。修正为显式构建
`migrate` 镜像，并保护已冻结回滚镜像不被覆盖后再次执行，0030、0031 顺序成功。
这是部署编排问题，不是 POOL-014 代码问题，未重开功能验收。

## 2. 服务与公网健康

| 检查 | 结果 |
| --- | --- |
| `https://gw.qianliuai.com/health` | HTTP 200，TLS 校验通过 |
| `https://ic.qianliuai.com/` | HTTP 200，管理页可达 |
| `https://ic.qianliuai.com/api/health` | HTTP 200，Control API 可达 |
| Gateway / Control API / Web / Worker / Caddy | 同一 Release 工作目录 |
| PostgreSQL / Redis | `healthy` |
| Worker | `healthy`，单实例，最近 Tick 成功，无最近错误 |
| 七个生产容器 | 全部 `running`，`RestartCount=0` |
| Caddy 流式配置 | 生效，容器内 `flush_interval -1` 唯一命中 |

Redis 继续使用固定 digest 的派生状态容器；其工作目录标签保留历史值，不承载产品版本。
应用版本一致性按 Gateway、Control API、Web、Worker、Caddy 核对，均指向本次 Release。

## 3. POOL-014 最小生产冒烟

- 链路：公网 Gateway → Caddy → Gateway → 真实 Kimi `CODING_PLAN`。
- HTTP 200；`Content-Type: text/event-stream; charset=utf-8`。
- 响应头约 `2.449s`，首块约 `2.450s`，总时长约 `9.384s`。
- 正常收到 `[DONE]` 和流内 usage。
- 内部请求 ID：`43407413-6900-45e9-be86-a828d63ebb68`。
- 数据库：`ai_request=SUCCEEDED`，Attempt HTTP 200，`failure_layer=null`；
  `usage_event=1`、`ledger_line=1`、`ledger_transaction=SETTLED`，总 Token `101+204`。
- 临时主体已停用，临时 Key 已撤销，临时 Grant 已停用；未保存 Key 明文或请求正文。

结论：POOL-014 部署后最小生产冒烟通过。其完整验收不重开。

## 4. 运行保障生产确认

- 管理页与 Control API 公网可达。
- Worker 只有一个运行实例，健康端口返回 `status=ok`、`running=true`、
  `lastSuccessAt` 有值、`lastErrorAt=null`。
- 在 PostgreSQL 短暂持有 `hashtext('qianliu_runtime_assurance')` 锁时，第二连接
  `pg_try_advisory_lock` 返回 `false`，互斥锁生效；锁随后正常释放。
- 创建禁用通知端点、无企微身份的受控 TEST Outbox，不调用真实企微。常驻 Worker
  单次领取后进入安全终态：`SKIPPED / attempt_count=1 /
  RECIPIENT_IDENTITY_MISSING`，证明调度、领取、幂等执行和终态回写闭环。
- Worker 发布后错误日志命中 `0`，所有容器异常重启为 `0`。

真实企微成员到达需要业务侧真实配置和可见范围，更多厂商信号与客户端中文展示也需要
扩大样本；按 Owner 决策全部进入发布后蓄水池，不阻塞本次生产基线结论。

## 5. 生产留痕与回滚

- 发布日志：`/Users/stephen/final-release-dd80e975.log`
- 当前 Release 指针：`/Users/stephen/qianliu-current-release.txt`
- 候选包：`/Users/stephen/qianliu-dd80e975.tar.gz`
- 数据库备份：
  `/Users/stephen/仟流智算-backups/final-pre-dd80e975-20260801-154700.sql.gz`
- 旧 Release：`/Users/stephen/releases/qianliu-zhisuan-pool013-20260731-222133`
- 旧镜像：`qianliu-rollback-dd80e975-{control-api,gateway,web}:pool013`
- 临时 SSH 映射 `codex-final-release-temp` 已于 `17:31 CST` 关闭并删除，映射列表恢复为空。

回滚时必须先停新版本写入口；如仅应用回滚，恢复旧镜像并从旧 Release 启动；如需数据
回滚，先重建目标数据库，再按 `02-preflight-access.md` 的恢复命令导入迁移前备份。
不得在新版本仍写入时直接覆盖数据库。

## 6. 发布后蓄水池

以下项目不阻塞“项目已完成”，按日常使用反馈排期：

1. `POOL-002` 正式业务验收。
2. `POOL-009`～`POOL-012` 真实套餐数字、厂商同步/账单对账和生产规模业务验证。
3. 真实企微成员到达、可见范围和消息内容业务验收。
4. 真实 Kimi K3 超过 60 秒长流、历史 404 分层定位。
5. Claude Desktop、Claude Code、CC Switch Codex、WorkBuddy 及更多真实厂商扩大回归。

## 7. 最终结论

**仟流智算开发完成，首次生产发布及基础验收通过，进入日常使用和蓄水池迭代阶段。**
