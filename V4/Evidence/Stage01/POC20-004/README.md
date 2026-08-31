# POC20-004A：容量、BOM 与恢复校准 Evidence

| 项目 | 内容 |
| --- | --- |
| 状态 | `done` |
| 结果 | `PASS_WITH_LIMITATIONS` |
| 日期 | 2026-08-11（Asia/Shanghai） |
| 阶段 | Stage 01：方案准备 |
| 数据边界 | 仅合成数据、隔离 PostgreSQL／本地 Stub；未访问生产或真实厂商 |
| 唯一产品候选 | `v1.0.0-final^{commit}` → `b3fb74b387ef61734d949be2e97fab7904bca959` |
| Final Tree | `68719129f9e9ee6a0ebfa56ab371cc42912fb34c` |
| Final Gateway 执行人／时间 | `Codex / Stage01 Execution`；2026-08-11T11:37:51Z～11:38:14Z |
| PoC 输入 Bundle SHA-256 | `81cc238f1b5e4bd75c3e54450d1c1bbec607e3cc0818283eb093fd12e95c8802` |
| Gateway 原始 stdout | [final-tag-gateway-staircase.stdout.log](./final-tag-gateway-staircase.stdout.log)；SHA-256 `a2262a22be93f64273b0d39614f5a21aba0a1ddc8a2c07d2e99c3901971df9e7` |
| 决策写回 | [ADR-20-004](../../../ADR/ADR-20-004-标准版容量与恢复包络.md)、PRD `DEC-010`、TRD §17～18 |

## 1. 结论

Stage 01 已获得足够证据冻结一个保守的标准版容量包络，但不能把完整 2.0 候选写成已达标：

- 数据面在 1,000 Principal、1,000 万月账本下，代表性结账聚合 3.17 秒，常用查询 P95 2.66ms，500 路混合查询 P95 223ms；
- 1,000 万行备份 15.9 秒、恢复到全新库 36.5 秒，恢复后行数和事实 Hash 一致；
- Final Tag 的真实 1.0 Gateway 在 500 普通＋200 流式并发下全部成功且 710 套账本事实守恒，但自增 TTFT P95 为 788.328ms，未达到 150ms；
- Final Tag 的 100＋50 档自增 TTFT P95 为 193.859ms，仍未达标；50＋20 档为 79.408ms，达到阈值。

因此，`DEC-010` 冻结标准版默认值为 100 成员、1,000 Principal、50 Gateway 并发、20 流式并发、1,000 万已结算 ledger line／月；500＋200 保留为优化后的 Stretch Goal，不能写进标准版默认承诺。完整 2.0 同一候选必须在 W20-18／W20-19 再验证。

## 2. 为什么是 POC20-004A

Stage 01 时 2.0 Schema、管理查询、结账实现和最终部署尚不存在，若要求现在证明“完整 2.0 候选容量与恢复”，会与 W20-18／W20-19 形成循环依赖。本 PoC 的职责是校准并冻结 `DEC-010`、BOM、负载入口和停止线；最终资格验证仍属于 Gate 2。

这不是降低标准，而是区分：

- 004A：方案能否进入开发、默认值定多少；
- W20-18／W20-19：成品是否真的达到这些值。

## 3. 复现入口

数据库完整档（产品代码无关的代表性 Schema 校准入口）：

```bash
POC20_PROFILE=full ./V4/PoC/POC20-004/run.sh
```

数据库冒烟档：

```bash
POC20_PROFILE=smoke ./V4/PoC/POC20-004/run.sh
```

文件：

- [代表性容量 Schema](../../../PoC/POC20-004/schema.sql)
- [数据库容量断言](../../../PoC/POC20-004/database_capacity_check.cjs)
- [真实 1.0 Gateway 容量断言](../../../PoC/POC20-004/gateway_capacity_check.ts)
- [结构化结果](./result.json)
- [Final Gateway 阶梯原始 stdout](./final-tag-gateway-staircase.stdout.log)

本轮为解除候选不一致，只在 `git archive v1.0.0-final^{commit}` 快照中重跑 Gateway 阶梯。数据库 1,000 万行、备份和恢复校准不导入产品源码，且当前 `schema.sql`／`database_capacity_check.cjs` 指纹与原运行完全相同，因此复用原结构化结果；本轮没有伪造一次新的数据库执行时间或 stdout。

Final Gateway 阶梯的实际复现方式：

```bash
final_dir="$(mktemp -d)"
git archive 'v1.0.0-final^{commit}' | tar -x -C "$final_dir"
mkdir -p "$final_dir/V4/PoC"
cp -R V4/PoC/POC20-004 "$final_dir/V4/PoC/POC20-004"
cd "$final_dir"
corepack pnpm@11.11.0 install --offline --frozen-lockfile

POC20_GATEWAY_CONCURRENCY=50 POC20_STREAM_CONCURRENCY=20 \
  corepack pnpm@11.11.0 --filter @qianliu/gateway exec tsx \
  "$final_dir/V4/PoC/POC20-004/gateway_capacity_check.ts"
# 再按相同命令执行 100/50 与 500/200。
```

`run.sh` 是数据库＋Gateway 一体化便捷入口，但内部读取 Git 状态；它不是本轮无 `.git` Final archive Gateway 复验所用命令。

## 4. 完整档实际结果

### 4.1 数据库与查询

环境：Apple M1 Pro 8 核／16GB；Docker 分配 8 核／约 7.65GB；PostgreSQL 17.10 ARM64。

| 检查 | 实际结果 |
| --- | ---: |
| 合成成员／Principal／月账本 | 100／1,000／10,000,000 |
| 数据生成／索引分析 | 93.70s／14.50s |
| 代表性结账 Rollup | 3.166s |
| 常用经营汇总 P95 | 2.659ms |
| 账本明细游标 P95 | 2.459ms |
| 500 路混合查询 P95 | 222.966ms |
| Ledger heap／index／total | 1.170GB／1.312GB／2.482GB |
| RLS 同企业／跨企业可见行 | 10,000,000／0 |
| Rollup 与基础事实 | 行数、Token、金额 100% 一致 |

### 4.2 备份与恢复

| 检查 | 实际结果 |
| --- | ---: |
| 压缩 Dump | 193,757,977 bytes；15.917s |
| 全新 PostgreSQL Restore | 36.530s |
| 恢复行数 | 10,000,000 |
| 源／恢复事实 Hash | 均为 `a210f51fa777155a6398e1c6cd0a1143` |
| Dump SHA-256 | `4fc26f91e5f8fe42a8cbff468e31cf953a4f36495c608dce4609ee2e220da25a` |

该结果证明本地代表性数据可恢复且观测 RTO 远小于 4 小时；单次演练不能证明每日调度、加密、保留和持续 RPO 已经实现。

### 4.3 Gateway 阶梯

全部档位均在 Final Commit／Tree archive 中运行真实 1.0 Gateway、HTTP Stub、PostgreSQL 真实账本，不是当前工作目录，也不是 ThinGateway 进程内模拟：

| 普通／流式并发 | 成功 | 账本守恒 | Gateway 自增 TTFT P95 | ≤150ms |
| ---: | ---: | ---: | ---: | --- |
| 500／200 | 500/500、200/200 | 710/710 | 788.328ms | 否 |
| 100／50 | 100/100、50/50 | 160/160 | 193.859ms | 否 |
| 50／20 | 50/50、20/20 | 80/80 | 79.408ms | 是 |

500／200 的功能成功不等于产品容量通过；延迟门槛不达标，所以不能用“请求没报错”冒充性能达标。

## 5. 冻结的 Stage 01 包络

| 项目 | 标准版默认 | 说明 |
| --- | ---: | --- |
| 成员 | 100 | 组织管理包络 |
| Principal | 1,000 | 含员工与项目调用主体 |
| Gateway 并发 | 50 | admission 默认；最终候选复验 |
| 流式并发 | 20 | admission 默认；真实长流仍待复验 |
| 月账本 | 10,000,000 条已结算 ledger line | 不等于两张表各 1,000 万 |
| 常用管理查询 | P95≤500ms | 使用正式读模型和固定查询集 |
| Gateway 自增 TTFT | P95≤150ms | 相对同机直连 Stub |
| 结账 | ≤30 分钟 | 正式分摊＋Statement 全链，不以本轮 3.17s 替代 |
| RPO／RTO | ≤24h／≤4h | 需自动备份和完整隔离恢复 |
| 默认 BOM | 8 vCPU／16GB RAM／250GB SSD | 本轮 Docker 仅约 8GB；完整 Compose 必须复验 |

500 Gateway＋200 流式并发是 Stretch Goal。只有 W20-19 在完整 2.0 同一候选、真实负载分布和目标 BOM 上满足全部门槛后，才允许提升默认值。

## 6. 限制与后续硬门禁

- 数据库使用代表性 2.0 Ledger／Rollup，不是正式 Schema、分摊引擎或 Statement。
- Gateway 使用 Final Tag 的真实 1.0 Pipeline，不含 2.0 RLS、组织、预算和账期代码。
- 数据库完整档复用同一 PoC 输入指纹的既有结构化结果；原运行没有保留原始 stdout，本轮未重跑 1,000 万行数据库部分，也没有把复用结果伪装成 Final archive 产品代码测试。
- 流式仅保持 120ms、Payload 很小；多分钟长流、大 Payload、稳态 RPS、失败率和 Attempt 分布尚未验证。
- 压测器与服务同机，未记录每容器 CPU／RSS 时间序列。
- 未注入 Redis、Worker、对象存储、PostgreSQL failover、网络和磁盘故障。
- W20-18 必须完成加密备份、调度、保留、恢复和 RPO 证据；W20-19 必须在完整 2.0 候选复跑 50／20 默认档和 500／200 Stretch 档。

## 7. 当前 PoC 门禁与后续风险

- 当前 PoC 对象阻断项：P0=`0`、P1=`0`；Stage 01 校准已冻结 50／20 默认包络，因此状态保持 `done / PASS_WITH_LIMITATIONS`。
- Gate 2 拉伸目标：500 Gateway＋200 流式并发仅是完整 2.0 候选的 Stretch Goal，不是当前 PoC 的未关闭 P1，也不得写成标准版默认承诺。
- 后续实现门禁：正式 2.0 容量、真实长流、全 Compose、加密备份调度和持续恢复必须在 W20-18／W20-19 对同一候选复验。
- 残余风险：云成本、外部 PostgreSQL／Redis、不同 CPU 架构和对象存储吞吐留到目标环境选定后校准；这些不是当前 PoC 对象的阻断项。
