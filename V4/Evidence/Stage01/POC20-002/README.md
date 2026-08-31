# POC20-002：0044 迁移、回滚与重升 Evidence

| 项目 | 内容 |
| --- | --- |
| 状态 | `done` |
| 结果 | `PASS_WITH_LIMITATIONS` |
| 日期 | 2026-08-11（Asia/Shanghai） |
| 阶段 | Stage 01：方案准备 |
| 数据边界 | 三个隔离数据库、仅合成数据；未连接生产、未修改产品迁移目录 |
| Executor | `Codex / Stage01 Execution` |
| 精确执行时间 | 基线核验 `2026-08-11T11:42:59Z`；PoC `2026-08-11T11:43:51Z` ～ `11:44:00Z`（北京时间 19:43:51～19:44:00） |
| 产品 Candidate | Tag `v1.0.0-final`；Commit `b3fb74b387ef61734d949be2e97fab7904bca959`；Tree `68719129f9e9ee6a0ebfa56ab371cc42912fb34c` |
| Migration Tree | Final Tag 与 Workspace 均为 Git Tree `2e21e1b8c4a286784c5d50cc85046b3508a538aa` |
| Workspace HEAD | `c04df1f7d2ea84f2cdbd2bddfe2f586c7ee451d8`，仅记录执行环境，不是产品候选 |
| PoC Bundle Manifest SHA-256 | `7df7c6d8279bec155cb4131c84ac06d68531a1cffb73c79fe6257bd4b13c4fdd` |
| 决策写回 | [ADR-20-002](../../../ADR/ADR-20-002-0044迁移与回滚边界.md)、[TRD §15](../../../仟流智算-技术需求文档-v2.0.md#15-迁移策略) |

`PoC Bundle Manifest` 是 [bundle-manifest.sha256](./bundle-manifest.sha256) 的文件字节 SHA-256。Manifest 只纳入 `V4/PoC/POC20-002/` 顶层七个执行输入，文件名按 `LC_ALL=C` 字节序排序；每行格式为“文件 SHA-256＋两个 ASCII 空格＋相对文件名＋LF”，末行也保留 LF。生成后的 Evidence、容器数据和时间输出不纳入 Bundle；产品迁移由 Final Tag、Migration Git Tree 与独立 Manifest 三重锁定。

## 1. 结论

真实 `0000→0044` 迁移链之上的代表性 2.0 迁移合同可成立：显式提供目标企业、先做跨企业与未知归属审计、再回填 10 张单工作空间表、增加复合约束，并在 Writer 切流前允许 `up→down→old-read→up`。旧字段数据 Hash、账本 Token／金额守恒和经营账单快照在全部 checkpoint 保持不变。

PoC 状态为 `done`，因为迁移方法、失败边界和回滚边界已经有真实结果；结果不是正式 `0045` 或上线演练通过。产品迁移、真实历史数据、Schema drift、新旧应用候选和目标规模锁时仍属于 Stage 02 实现／Gate 2 验证。

## 2. 复现入口

### 2.1 Final Tag 迁移基线核验

执行 PoC 前已只读证明当前 `packages/database/migrations` 与 `v1.0.0-final` 完全相同：

| 检查 | 实际结果 |
| --- | --- |
| Final Commit／Tree | `b3fb74b…a959`／`68719129…c34c` |
| Final／Workspace Migration Git Tree | 均为 `2e21e1b8…38aa` |
| `git diff v1.0.0-final -- packages/database/migrations` | 0 个差异文件 |
| Workspace migration 修改／未跟踪 | 0 项 |
| Migration 文件数 | 45 |
| [Migration Manifest](./migration-manifest.sha256) SHA-256 | `4be761e1822f5aa7ee51d72784bc2e8d93e07a0067f9ff48b3b604c885478f29` |

原始核验元数据见 [migration-baseline-verification.txt](./migration-baseline-verification.txt)，SHA-256 `f8c3848d687bde73bcdb10246992a79c794cc61a47a2f475da37b09c0eca9673`。Migration Manifest 与 PoC Bundle 使用相同规范，只是筛选为迁移目录顶层 `*.js`。

精确复算命令：

```bash
git rev-parse 'v1.0.0-final^{commit}'
git rev-parse 'v1.0.0-final^{tree}'
git rev-parse 'v1.0.0-final:packages/database/migrations'
git rev-parse 'HEAD:packages/database/migrations'
git diff --exit-code v1.0.0-final -- packages/database/migrations
test -z "$(git status --porcelain=v1 -- packages/database/migrations)"

(
  cd packages/database/migrations
  find . -maxdepth 1 -type f -name '*.js' -print0 | LC_ALL=C sort -z |
  while IFS= read -r -d '' file; do
    printf '%s  %s\n' "$(shasum -a 256 "$file" | awk '{print $1}')" "${file#./}"
  done
) > /tmp/poc20-002-migration-manifest.sha256
diff -u V4/Evidence/Stage01/POC20-002/migration-manifest.sha256 /tmp/poc20-002-migration-manifest.sha256
shasum -a 256 /tmp/poc20-002-migration-manifest.sha256

(
  cd V4/PoC/POC20-002
  find . -maxdepth 1 -type f -print0 | LC_ALL=C sort -z |
  while IFS= read -r -d '' file; do
    printf '%s  %s\n' "$(shasum -a 256 "$file" | awk '{print $1}')" "${file#./}"
  done
) > /tmp/poc20-002-bundle-manifest.sha256
diff -u V4/Evidence/Stage01/POC20-002/bundle-manifest.sha256 /tmp/poc20-002-bundle-manifest.sha256
shasum -a 256 /tmp/poc20-002-bundle-manifest.sha256
```

### 2.2 PoC 执行

```bash
V4/PoC/POC20-002/run.sh
```

脚本会创建一次性 PostgreSQL 17 容器和三个数据库，分别验证成功迁移、缺少部署清单、跨企业脏数据；退出时自动销毁。文件：

- [代表性 up](../../../PoC/POC20-002/representative_up.sql)
- [代表性 down](../../../PoC/POC20-002/representative_down.sql)
- [成功路径 Fixture](../../../PoC/POC20-002/seed_valid.sql)
- [缺清单 Fixture](../../../PoC/POC20-002/seed_ambiguous.sql)
- [跨企业 Fixture](../../../PoC/POC20-002/seed_cross_tenant.sql)
- [断言程序](../../../PoC/POC20-002/migration_check.cjs)
- [结构化结果](./result.json)
- [本次原始执行输出](./stdout-20260811T114351Z.log)，SHA-256 `d0b34955525b3ec1376a155f9f64382d17589d750ef9353219bef6bf49440862`

## 3. 实际路径与结果

```text
真实 Kysely 0000→0044（45 条）
→ 固定合成历史事实
→ 代表性 2.0 up
→ 复合 FK／旧版只读／Hash／守恒检查
→ down 到 0044
→ 旧版只读检查
→ 代表性 2.0 re-up
→ Writer 切流后 down 阻断
```

| 检查 | 实际结果 |
| --- | --- |
| 迁移锚点 | 45 条；最后一条 `0044_operating_bill_model_identity` |
| 10 张缺企业表 | 10/10 回填且 `NOT NULL` |
| 代表性复合约束 | 79 条 |
| 跨企业复合 FK 写入 | SQLSTATE `23503` |
| 旧版兼容角色 | 读取 3 条 Request；写入 SQLSTATE `42501` |
| 首次 up | 134.50 ms；仅为小样本本机结果 |
| down | 48.95 ms；语义 Schema Hash 回到原 0044 |
| re-up | 104.37 ms；语义 Schema Hash 与首次 up 相同 |
| 旧字段数据 Hash | 四个 checkpoint 均为 `fb8dc8c5…7924` |
| 缺少目标企业清单 | SQLSTATE `P2000`；DDL 残留 0 |
| 跨企业脏引用 | SQLSTATE `P2002`；DDL 残留 0 |
| Writer 已切流后 down | SQLSTATE `P2004`，主动阻断 |

## 4. 账本与账期不变量

Fixture 覆盖 API failover、Coding Plan、超出 JavaScript 安全整数范围的 Token、未知历史 Alias、在途 Request、已关闭账期和重开历史。各 checkpoint 一致：

| 指标 | 结果 |
| --- | ---: |
| Request／Attempt／Usage／Line／Transaction | 3／4／2／2／2 |
| Input／Output／Cache／Reasoning Token | 9007199254741093／90／180／7 |
| 套餐扣减／API 金额 | 200／2.50 |
| 账期／历史 Statement | 2／2 |
| Usage↔Ledger Line 字段错配 | 0 |
| Ledger Transaction 守恒错配 | 0 |

Hash 明确只选取 0044 老字段，不使用 `SELECT *`；否则新增列会制造假差异。上述 Hash 只用于同一次运行内比较迁移前、up、回滚和 re-up／重放 checkpoint 是否相等。Fixture 或迁移元数据中的生成时间和值可能在另一次运行变化，因此本 Evidence 记录本轮实测值，但不把这些值承诺为跨运行固定的 Golden Hash。

## 5. 写回的迁移合同

1. 正式迁移必须显式接收受控部署清单中的目标企业 ID；缺失、目标不存在、库中企业数量不符合标准部署或父链冲突时，在 DDL 前中止并输出对象清单。
2. 10 张单工作空间表先加 nullable、无默认值的 `enterprise_id`，按可证明父链回填；孤立根对象只能使用显式部署清单，不能猜测。
3. 迁移前后用显式老字段 Hash、完整 Token／金额／Attempt 守恒和 Statement Hash 对账；现有 W17 对账不足以单独证明 cache、reasoning、quota、cost 和 Attempt 守恒。
4. 旧版兼容角色必须是非 Owner、非超级用户、`NOBYPASSRLS` 的只读角色；当前 Compose 共用超级用户的方式不能作为写栅栏。
5. `R1`：2.0 Writer 尚未切流且无 2.0-only 写入时，可 Schema down 到 0044；验证完成前旧版保持只读。
6. `R2`：2.0 Writer 已切流或已有 2.0-only 数据后，禁止 Schema down；只允许应用回退＋前向修复，或按备份／PITR 方案单独恢复。
7. PostgreSQL drop／re-add 会改变物理列序号。本 PoC 首次 up 与 re-up 的语义 Schema Hash 一致，但 10 张表的列序号均 `+1`；任何客户端、导出和脚本不得依赖 `SELECT *` 的物理列顺序。

## 6. 限制

- 2.0 覆盖层位于 `V4/PoC/`，不是正式 `packages/database/migrations/0045_*`，也未写入 Kysely 迁移台账。
- 没有生产 Schema、手工 DDL、真实历史数据和多 GB 表，不能证明实际回填歧义、锁时或磁盘水位。
- 没有运行真实 1.0／2.0 应用候选；旧版检查只证明数据库角色的代表性查询与写权限。
- 未在本 PoC 冻结组织、RBAC、预算等最终新表，这些仍由正式 TRD Schema 与 W20-03 实现。
- 当前运行保障测试主动断言相关表没有 `enterprise_id`；正式迁移时必须同步改写该旧合同测试。

## 7. 当前 PoC 门禁与后续风险

- 当前 PoC 对象阻断项：P0=`0`、P1=`0`；迁移方法、失败边界和回滚边界已经回答，因此状态保持 `done / PASS_WITH_LIMITATIONS`。
- 后续实现门禁：正式 `0045+`、部署角色拆分、归属审计清单、新旧应用兼容栅栏和真实副本演练仍是开发／发布前置，不得用本 PoC 替代。
- 残余风险：物理列序号漂移、目标规模迁移锁时、生产 Schema drift 和资源成本需要在正式实现／Gate 2 复验；它们不是当前 PoC 对象的未关闭 P1。
