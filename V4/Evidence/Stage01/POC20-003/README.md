# POC20-003：账期水位、并发与失败恢复 Evidence

| 项目 | 内容 |
| --- | --- |
| 状态 | `done` |
| 结果 | `PASS_WITH_LIMITATIONS` |
| 日期 | 2026-08-11（Asia/Shanghai） |
| 阶段 | Stage 01：方案准备 |
| 数据边界 | 一次性 PostgreSQL 17 容器、两个合成企业和六个合成账期；未修改产品迁移和业务代码 |
| 唯一产品候选 | `v1.0.0-final^{commit}` → `b3fb74b387ef61734d949be2e97fab7904bca959` |
| Final Tree | `68719129f9e9ee6a0ebfa56ab371cc42912fb34c` |
| 执行人／时间 | `Codex / Stage01 Execution`；2026-08-11T11:37:06Z～11:37:18Z |
| PoC 输入 Bundle SHA-256 | `8e120072948093658496888b63c719e019d38c3dc2c8321950a4a3a9a6500751` |
| 原始 stdout | [final-tag-run.stdout.log](./final-tag-run.stdout.log)；SHA-256 `48df49b15392860f9a2e37b9d4f73e2c12a4039df2f7a88aa97d2fa51a7b34ed` |
| 决策写回 | [ADR-20-003](../../../ADR/ADR-20-003-账期状态机水位与锁序.md)、[TRD §9](../../../仟流智算-技术需求文档-v2.0.md#9-月度经营账期) |

`PoC 输入 Bundle` 指执行前冻结的、由 `run.sh` 实际调用的 `fixture.sql`、`overlay.sql`、`run.sh`、`state_machine_check.cjs`。先按相对路径生成四个文件的 SHA-256 manifest，再对 manifest 取 SHA-256 得到上表 Bundle 指纹；生成后的 `README.md`、`result.json`、容器数据和运行输出不属于输入 Bundle。产品源码、迁移和回归测试只来自 Final Commit／Tree，不再绑定当前工作目录 HEAD。

## 1. 结论

代表性 2.0 合同可成立：账期只使用 `DRAFT / CHECKING / CLOSED / REOPENED` 四态；检查失败作为 `period_check.result=FAILED` 保存并回到 `DRAFT`；Settlement 与 Close 使用同一企业账期锁后，不会少记、重复或在 `CHECKING/CLOSED` 后迟到写入；Statement 以单调 `settlement_seq`、最后结算时间／ID和 PostgreSQL transaction snapshot 记录水位；重开生成新版本且旧 Statement 不变。

PoC 为 `done / PASS_WITH_LIMITATIONS`，表示状态机、水位、锁、幂等和恢复方案已有真实数据库证据，不表示 2.0 产品实现完成。正式 Schema、Gateway／Worker 接入、请求 Hash、双 Hash、真实进程崩溃、分摊守恒和容量仍在后续工作包验证。

## 2. 复现入口

```bash
final_dir="$(mktemp -d)"
git archive 'v1.0.0-final^{commit}' | tar -x -C "$final_dir"
mkdir -p "$final_dir/V4/PoC"
cp -R V4/PoC/POC20-003 "$final_dir/V4/PoC/POC20-003"
cd "$final_dir"
corepack pnpm@11.11.0 install --offline --frozen-lockfile
V4/PoC/POC20-003/run.sh
```

脚本先在 Final archive 中运行经营账并发回归文件：源码含 35 个静态 `it/test` 声明，Vitest 参数化展开后实际执行 `57/57`；再将代表性 2.0 Overlay 应用到 Final 的真实 `0000→0044` 数据库，执行并发和故障场景，退出时销毁容器。文件：

- [代表性 Schema／函数 Overlay](../../../PoC/POC20-003/overlay.sql)
- [合成 Fixture](../../../PoC/POC20-003/fixture.sql)
- [并发断言程序](../../../PoC/POC20-003/state_machine_check.cjs)
- [结构化结果](./result.json)

## 3. 实际结果

| 检查 | 实际结果 |
| --- | --- |
| Final 经营账并发回归 | 35 个静态声明；Vitest 展开执行 `57/57` 通过 |
| 账期状态 | 四态，约束中无 `CHECKING_FAILED` |
| 检查失败 | `period_check=FAILED`，账期回 `DRAFT` |
| 在途 Settlement | Close 返回 `P3002`；结算完成后重试成功且 Statement 含 1 条事实 |
| Settlement-first | Close 等待月锁，提交后精确纳入 1 条事实 |
| Close-first | Settlement 等待月锁，Close 提交后以 `P3003` 拒绝迟到写入 |
| Close 幂等 | 同键 20 路并发重放全部返回同一版本／Hash／数量；不同键在已关闭账期返回 `P3006` |
| Reopen 幂等与 ABA | 同键重放不改变 v2；旧版本＋新键返回 `P3013` |
| 水位 | v1/v2 的 `settlement_seq` 为 `1/2`，单调推进 |
| 历史不可变 | 旧 Hash 不变；直接 UPDATE 返回 `P3008`；全部 Hash 可从已存 payload 复算 |
| 故障恢复 | CHECKING 前回滚残留 0；Statement 事务回滚残留 0；过期 Lease 恢复成功 |
| 企业隔离锁 | 企业 A 持锁不阻断企业 B 同期操作 |
| 跨时区 | 同一 UTC 时点分别归属上海 `2026-08`、洛杉矶 `2026-07`；区间右端返回 `P3005` |
| 最终不变量 | 永久 CHECKING 0、RUNNING Check 0、重复 Settlement 0、当前版本／Hash 错配 0 |

## 4. 冻结的工程合同

1. 账期状态枚举只有四态；`RUNNING/PASSED/FAILED` 属于 Check 结果，不得塞进账期状态。
2. Close 使用短事务进入 `CHECKING`，再在短事务内冻结 Statement；不得在数据库事务中跨 HTTP、SSE 或模型调用。
3. 正式水位为 `{settlement_seq, last_settled_at, last_settlement_id, transaction_snapshot}`；`settlement_seq` 在账期锁内事务性递增，是权威顺序。
4. Settlement 写入按稳定锁序进入账期栅栏；`CHECKING/CLOSED` 拒绝新写。相同 Settlement ID 只可在请求 Hash 一致时重放原结果。
5. Close／Reopen 请求必须携带 `operation_id + expected_version + request_hash`；同键同参重放，同键异参冲突，防止 reopen ABA。
6. Statement 版本不可更新或删除；重开只新增调整和下一版本。正式实现保存 `source_fact_hash` 与 `statement_hash`、算法和 canonicalization 版本。
7. CHECKING 必须有 Lease；进程丢失后，恢复器按相同锁序把 Check 标为 `FAILED` 并将账期回 `DRAFT`，不得永久卡住。

## 5. 限制

- Overlay 位于 `V4/PoC/`，不是正式 `0045+` 迁移，也没有修改产品 Repository、Gateway 或 Worker。
- 故障注入采用事务错误／回滚＋Lease 过期，没有执行真实 `SIGKILL`、PostgreSQL failover 或网络分区。
- Overlay 命令表尚未保存请求 Hash；“同键异参冲突”已写入正式合同，但本次只验证同键重放、异键和 expected-version 冲突。
- Overlay 只保存 `statement_hash`，尚未分离 `source_fact_hash`，也未证明 Canonical JSON 在跨语言实现间一致。
- 未覆盖分摊金额守恒、跨多账期 Settlement、真实 Gateway 终态发布锁序和生产级锁争用。
- 目标规模吞吐、结账时限和恢复目标转 POC20-004。

## 6. 当前 PoC 门禁与后续风险

- 当前 PoC 对象阻断项：P0=`0`、P1=`0`；状态机、水位、并发锁和恢复方案的可行性问题已经回答，因此状态保持 `done / PASS_WITH_LIMITATIONS`。
- 后续实现门禁：正式实现必须补齐统一锁序、request hash、双 Hash、不可变权限、真实崩溃恢复和完整分摊守恒；本 PoC 不替代 W20-11～15 的验收。
- 残余风险：真实 SIGKILL、跨语言 Canonical JSON、跨多账期锁序和生产规模争用需要后续 Evidence；它们不是当前 PoC 对象的未关闭 P1。
