# POC20-001：企业隔离与 RLS 边界 Evidence

| 项目 | 内容 |
| --- | --- |
| 状态 | `done` |
| 结果 | `PASS_WITH_LIMITATIONS` |
| 日期 | 2026-08-11（Asia/Shanghai） |
| 阶段 | Stage 01：方案准备 |
| 数据边界 | 仅合成数据；未连接生产、未修改产品代码或产品 Schema |
| Executor | `Codex / Stage01 Execution` |
| 精确执行时间 | `2026-08-11T11:43:35Z` ～ `2026-08-11T11:43:38Z`（北京时间 19:43:35～19:43:38） |
| Candidate 语义 | 独立 PoC Schema；不读取产品源码，因此不把 Workspace HEAD 当产品候选 |
| 1.0 Final 参考 | Tag `v1.0.0-final`；Commit `b3fb74b387ef61734d949be2e97fab7904bca959`；Tree `68719129f9e9ee6a0ebfa56ab371cc42912fb34c` |
| Workspace HEAD | `c04df1f7d2ea84f2cdbd2bddfe2f586c7ee451d8`，仅记录执行环境，不是产品候选 |
| PoC Bundle Manifest SHA-256 | `9f75fb72b6c3d5dad1f98b2d0933b98931dd2b034ec57b62f9ce407a524db374` |
| 决策写回 | [ADR-20-001](../../../ADR/ADR-20-001-企业隔离与RLS边界.md)、[PRD DEC-008](../../../仟流智算-产品需求文档-v2.0.md#13-stage-01业务验证唯一决策清单)、[TRD §22](../../../仟流智算-技术需求文档-v2.0.md#22-关键-pocadr-台账) |

`PoC Bundle Manifest` 是 [bundle-manifest.sha256](./bundle-manifest.sha256) 的文件字节 SHA-256。Manifest 只纳入 `V4/PoC/POC20-001/` 顶层三个执行输入，文件名按 `LC_ALL=C` 字节序排序；每行格式为“文件 SHA-256＋两个 ASCII 空格＋相对文件名＋LF”，末行也保留 LF。生成后的 Evidence、容器数据和时间输出不纳入 Bundle。

精确复算命令：

```bash
(
  cd V4/PoC/POC20-001
  find . -maxdepth 1 -type f -print0 | LC_ALL=C sort -z |
  while IFS= read -r -d '' file; do
    printf '%s  %s\n' "$(shasum -a 256 "$file" | awk '{print $1}')" "${file#./}"
  done
) > /tmp/poc20-001-bundle-manifest.sha256
diff -u V4/Evidence/Stage01/POC20-001/bundle-manifest.sha256 /tmp/poc20-001-bundle-manifest.sha256
shasum -a 256 /tmp/poc20-001-bundle-manifest.sha256
```

## 1. 结论

标准版的企业隔离方案在以下前提下可成立：业务表直接携带 `enterprise_id`，同企业关系使用复合 FK／唯一约束，应用使用非表 Owner、`NOSUPERUSER`、`NOBYPASSRLS` 的运行角色，并且只在短事务内通过参数化 `SET LOCAL` 设置企业上下文。RLS 作为数据库第二道防线，不替代认证、RBAC 和应用层企业过滤。

本 PoC 已回答“方案是否可行”，因此 PoC 状态为 `done`；结果不是“产品实现通过”。当前 1.0 是明确的单工作空间设计，尚不满足 2.0 企业隔离合同，对应实现和回归仍属于 W20-02～W20-06、W20-15、W20-19 的 `todo` 工作。

## 2. 动态验证

### 2.1 复现入口

```bash
V4/PoC/POC20-001/run.sh
```

脚本使用一次性 `postgres:17-alpine` 容器、两个合成企业和项目实际依赖中的 `pg.Pool 8.16.3`；退出时自动销毁容器。输入和断言见：

- [schema.sql](../../../PoC/POC20-001/schema.sql)
- [pool_rls_check.cjs](../../../PoC/POC20-001/pool_rls_check.cjs)
- [run.sh](../../../PoC/POC20-001/run.sh)
- [结构化结果](./result.json)
- [本次原始执行输出](./stdout-20260811T114335Z.log)，SHA-256 `019fd4e4aaaadc6212266c8fbe2a3716341cc97bd41f3c3099bb41b5d842b61b`（命令执行器合并展示了 PostgreSQL NOTICE）

环境指纹：PostgreSQL `17.10`、镜像 ID `sha256:93aa428db0aeeb71d24dcad1491bef6e1396a4255697e4bfc4c725bfeb981b74`、Node.js `v22.17.1`、`pg 8.16.3`。

### 2.2 实际结果

| 场景 | 实际结果 | 判定 |
| --- | --- | --- |
| 运行角色 | `NOSUPERUSER / NOBYPASSRLS`，且不是表 Owner | 通过 |
| RLS 覆盖 | 5/5 代表表启用 `ENABLE/FORCE ROW LEVEL SECURITY` | 通过 |
| 无企业上下文读取 | 0 行 | fail-closed |
| 无上下文 insert／upsert | SQLSTATE `42501` | fail-closed |
| 无上下文 update／delete | 0 行受影响 | fail-closed |
| 企业 A 读取／更新企业 B | 0 行 | 通过 |
| 企业 A 写入企业 B 行 | SQLSTATE `42501` | 通过 |
| 企业 A 引用企业 B Principal | 复合 FK 返回 SQLSTATE `23503` | 通过 |
| 导出对象列表 | 企业 A 仅见 `enterprise/a/export.csv` | 通过；仅代表性表，不代表真实导出链已实现 |
| `SET LOCAL` 后连接复用 | commit、rollback 后均为 0 行 | 通过 |
| 非法 UUID 上下文 | SQLSTATE `22P02` | fail-closed |
| 错用 session-level `SET` | 成功复现上下文跨 checkout 残留 | 风险已证明；合同禁止 |
| 连接池并发 | `max=4`，24/24 次交替企业查询无串租户 | 通过 |
| 查询计划 | 两行样本为 `Seq Scan` | 不得得出性能结论；转 POC20-004 |

## 3. 对 1.0 源码的只读审计

### 3.1 Schema 现状

- 当前 54 张应用表中，扣除租户根表 `enterprise` 后有 53 张租户相关表；43 张直接有 `enterprise_id`，10 张没有，直接覆盖约 81%。
- 缺少直接企业归属的 10 张为：`admin_session`、`employee_login`、`quota_counter`、`person`、`person_external_identity`、`availability_rule`、`availability_rule_version`、`availability_event`、`notification_endpoint`、`notification_delivery`。
- 运行保障迁移明确按“单工作空间”设计，并由集成测试主动断言相关表没有 `enterprise_id`；这是 1.0 合同，不是 1.0 回归，但在 2.0 必须迁移。
- 当前只有 `provider`、`provider_resource`、`unified_model` 建立了可作为企业复合 FK 目标的 `UNIQUE (enterprise_id, id)`；含 `enterprise_id` 的复合 FK 仅 6 条。其余大量事实链仍依赖全局 UUID、Repository 过滤或 Join 归属，不能形成数据库不变量。
- JSON／多态引用暂时无法用普通复合 FK 保护，高风险授权和自动动作字段需要关系表或显式一致性校验。

### 3.2 运行时现状

- 当前 Compose 让迁移、Control API、Gateway 和 Worker 共用 PostgreSQL 官方镜像初始化账号；该账号通常是数据库超级用户，会绕过 RLS。2.0 必须拆分迁移／Owner 角色与运行角色。
- 当前 Repository 以全局 Kysely 根连接为主，没有“同一连接、同一短事务、先设置企业上下文再执行业务 SQL”的统一入口。
- 认证查 Session／Key 时尚未取得企业上下文。标准版一企业一部署必须从受信部署配置取得 `DEPLOYMENT_ENTERPRISE_ID`，在认证查询前设置上下文，并校验认证对象归属；共享 SaaS 需另立 ADR，禁止用 `BYPASSRLS` 绕过。
- 运行保障 Repository、Gateway 规则匹配和 Worker 当前存在全库查询／全局任务；2.0 必须显式企业化。Redis 生产 Key 和导出链当前未实现，不能声称已验证。

## 4. 写回的工程合同

1. 先执行 fail-closed 归属审计，再为缺失表新增、回填并最终 `NOT NULL` 的 `enterprise_id`；有歧义时中止并输出对象清单，禁止猜测。
2. 被租户子表引用的父表增加 `UNIQUE (enterprise_id, id)`，身份热路径、请求账本事实链、经营授权和运行保障链改为复合 FK。
3. 运行角色必须为非超级用户、非表 Owner、`NOBYPASSRLS`；迁移／Owner 使用独立连接配置。
4. 新增统一 `withEnterpriseTransaction`：同一连接开启短事务，以参数化 `set_config('app.enterprise_id', $1, true)` 为首个业务前置，再把该事务对象传给 Repository。禁止 session-level `SET`。
5. 不允许把模型 HTTP／SSE 调用包在数据库事务中；外部调用前后拆成短原子单元。
6. Worker Job 必须显式携带企业 ID，按企业加锁、幂等和落库；平台调度器只能枚举企业后逐企业进入上下文。
7. 标准版一企业一部署的认证 bootstrap 使用受信 `DEPLOYMENT_ENTERPRISE_ID`；客户端 Header 不得决定企业身份。
8. RLS 只作为第二道防线；应用认证、RBAC、企业过滤、复合约束和负向测试仍是必需项。

## 5. 限制与后续

- 未修改或运行 2.0 产品实现；当前应用接上这些策略仍会因角色、上下文和 Repository 合同不完整而失败。
- 未连接生产 PostgreSQL，无法证明生产迁移版本、手工 DDL、Schema drift 或历史回填是否存在歧义。
- 未动态执行真实 Control API、Gateway、Worker、Redis 和导出端到端链路；这些必须在实现工作包中补齐。
- 两行 Fixture 不能说明 RLS 性能成本；容量、锁和索引结果由 POC20-004 负责。
- POC20-002 必须对真实 `0044` 结构执行 `升级 → 校验 → 回滚 → 旧版只读 → 重升`，并逐条证明归属回填与账本不变量。

## 6. 当前 PoC 门禁与后续风险

- 当前 PoC 对象阻断项：P0=`0`、P1=`0`；企业隔离方案的可行性问题已经回答，因此状态保持 `done / PASS_WITH_LIMITATIONS`。
- 后续实现门禁：运行角色拆分、10 张表企业化、事实链复合约束、事务上下文、运行保障／Worker 企业化必须在对应工作包完成，不能用本 PoC 替代产品验收。
- 残余风险：Redis Key、真实导出链以及完整 2.0 候选上的性能仍未验证；这些是后续实现／Gate 2 风险，不是当前 PoC 对象的未关闭 P1。
