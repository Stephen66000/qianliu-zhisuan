# POOL-039／043 与 POOL-040／041 集成候选证据（2026-08-10）

## 结论

- **本地整改候选已完成定向回归和现有门禁，具备重新送最终双审条件；前一轮最终双审发现的唯一
  P1 已修复，但新对象尚未完成双审，当前结论不是最终 PASS。**
- 首次双审冻结的 3 项问题均已修复：终态撤权结算单事务、half-open probe 租约随请求超时派生、
  billing readiness 语义统一。修复改变了候选对象，首次双审结论不能复用，必须重新冻结并由两位
  独立 Reviewer 复核。
- 候选以 GitHub `main` 的 `c04df1f7d2ea84f2cdbd2bddfe2f586c7ee451d8` 为主线，合并
  POOL-040／041 集成来源提交 `79f335a574c14d7af3900e47c347bb32d0d45176`，保留产品提交
  `79ee91224a35268a730db6bf5f312148eac123e5`，并收口 POOL-039／043 的并发、
  撤权结算、迁移与 Web 缓存一致性。
- 本文件记录的是**提交前、部署前**证据；不代表已经上传 GitHub、更新 Mac Mini、完成生产业务
  验收或封板，也不核验当前生产运行版本。发布脚本执行前仍须独立确认生产数据库严格处于
  `0042_alias_ql_format`。
- POOL-042 仍是独立待修复项；本候选不把 canary 未扫描 PostgreSQL／Redis／Trace 写成全局 PASS。

## 前一轮最终双审 P1 整改

- 两位独立 Reviewer 对同一冻结对象均只发现 1 个 P1：首候选在最终栅栏撤权并完成非终态零事实
  结算后，若备用候选在创建 Attempt 前因 Grant、容量、探针或额度门禁退出，旧代码会直接写
  Request 终态，触发 `unsettled_request_terminal_write`，留下 `IN_PROGRESS` 且缺少
  `ledger_transaction`。
- 修复后，所有此类 `finalOutcome=null` 的退出统一先检查既有账本事实；有事实时聚合全部
  Attempt／ledger line，并由 `finalizeLedgerSettlementIfAbsent` 在 PostgreSQL 事务内原子创建唯一
  transaction 与发布 `FAILED`；无事实时才沿用普通早退终态入口。已由非终态 Attempt 结算的额度
  与租约不会重复处理。
- 真实 PostgreSQL 双候选回归在修复前稳定复现 HTTP 500 与
  `unsettled_request_terminal_write`；修复后返回预期 403，且上游 0 次、Request `FAILED`、唯一
  transaction、Attempt／line／汇总一致、quota used=0、两资源 active lease=0。

## 候选边界

| 项目 | 值 |
| --- | --- |
| 工作树 | `/private/tmp/qianliu-prod-integration` |
| 分支 | `codex/pool-039-043-prod-integration` |
| 主线基线／当前 HEAD | `c04df1f7d2ea84f2cdbd2bddfe2f586c7ee451d8` |
| 合并父提交 | `79f335a574c14d7af3900e47c347bb32d0d45176` |
| 迁移链 | `0042_alias_ql_format` → `0043_single_owner_rule_history` → `0044_operating_bill_model_identity` |
| 风险 | HIGH／R3：PostgreSQL 并发、账本原子性、Gateway 最终撤权、权限与经营账单 |
| 发布脚本 | `V3/Evidence/Production-Release/20260810-pool039043-integration/run-release.sh` |
| 冻结清单 | 最终双审前须重新生成并核验 `V3/Evidence/Final-Audit/POOL-039-043-integration-candidate.sha256`（排除自身） |

## 首次双审整改状态

| 首次双审问题 | 整改结果 | 当前状态 |
| --- | --- | --- |
| 终态撤权的 Attempt、零用量、额度退款与租约释放未形成完整单事务边界 | 无可安全 failover 候选时，Attempt 失败、零用量账本、quota refund 与 lease release 在同一 PostgreSQL 事务内提交；任一步失败整体回滚 | 已修复，待最终双审复核 |
| half-open probe 使用固定租约，可能短于可配置的完整请求超时 | 租约统一派生为 `request timeout + 60s`；700 秒请求超时对应 760 秒租约，并保留 fencing 防止旧持有者释放新租约 | 已修复，待最终双审复核 |
| billing readiness 在配置校验、模型目录和调用热路径间存在重复语义 | 统一使用同一计费规则匹配语义，资源、模型、时间窗和模式判断不再由各入口分别推导 | 已修复，待最终双审复核 |

## 集成修复闭环

### POOL-039：锁序与失败原子性

1. 单人保存、批量发布／停用统一为 ACTIVE Key → 手工权限基线 → provider/pool 的稳定锁序；
   真实 PostgreSQL 并发覆盖已有 manual baseline 的 PUT × 批量发布，未用重试掩盖死锁。
2. 撤权发生在额度 reserve／租约获取／Attempt 创建后、上游前，且已无可安全 failover 候选时，
   Attempt 失败、零用量事实、quota refund 与 lease release 在同一 PostgreSQL 事务完成；任一步
   失败整体回滚。仍有合法候选时继续 failover，不提前结算终态；若备用候选随后在 Attempt 前退出，
   已有事实通过请求级原子 finalize 汇总并发布 FAILED，不绕过 completion barrier。
3. 同一 Attempt 重复结算保持幂等；未触达 API 的 Attempt 显式记
   `api_cost=0.00000000`，不会吞掉后续成功 Attempt 的真实成本。
4. half-open probe 租约统一为完整请求超时加 60 秒安全余量；当前 700 秒请求超时派生 760 秒
   租约。fencing token 保证旧持有者不能释放新租约，超时后可由新请求安全接管。

### POOL-040／041：保留既有能力并补强集成语义

1. 配置校验、`/v1/models` 与调用热路径共用计费 readiness 匹配语义，并检查 Key／主体／模型／
   Grant／Route／Resource／Provider／计费规则；API 模式要求有效 API_PRICE 规则至少存在一种非空
   Token 单价，Coding 模式要求有效 TIME／MODEL 规则存在倍率。撤权只排除当前失效候选，可继续
   安全 failover。
2. reserve 后、上游前撤权不触达上游；仍有合法候选时继续 failover，无合法候选的终态撤权统一
   进入原子失败结算，避免额度、租约、账本或 Attempt 半成品。
3. 单人接入的重复 `provider_code` 与重复 `enabled_model_ids` 在数据库写入前稳定返回 400；
   输入 UUID 先归一化为小写再判重，大小写变体不能绕过。
4. Web 保存成功前等待相关 query invalidate/refetch 完成，成功提示后页面不会继续展示旧权限。

### POOL-043：迁移与经营账单

1. 员工账／项目账独立路由；员工总览可按厂商、稳定 `unified_model_id` 和正式 alias 下钻到请求。
2. Token、额度扣减、API 成本、套餐分摊和项目归属均读取后端账本事实；前端不重算金额。
3. 0044 保留请求发生时 alias，新增稳定模型身份；只回填可证明的既有数据，未知历史保持
   `NULL`；down 后旧结构可用并可再次 up。
4. 调度 REJECT／RATE_LIMIT 在动作前冻结 `matched_policy_action`、最终动作、原因和
   `saving_calculable=false` 审计，不因后续补证据失败丢失核心终态。

## 测试与质量门禁

### 全量测试

| workspace／范围 | 结果 |
| --- | ---: |
| Control API | **21 files / 154 tests PASS** |
| Gateway | **29 files / 233 tests PASS** |
| Database | **31 files / 196 tests PASS** |
| Web | **25 files / 119 tests PASS** |
| Domain | **161 tests PASS** |
| Provider Adapters | **104 tests PASS** |
| Observability／Config／Contracts／Worker | **9／9／3／10 tests PASS** |

- 首次全仓 `pnpm test` 未向 Testcontainers 注入当前 Colima socket，真实 PostgreSQL 套件未启动；
  显式指定 `DOCKER_HOST` 与容器内 socket 后，Database、Control API、Gateway 和 Worker 均按
  workspace 完整复跑并全绿。Control API 复跑前还修正了 2 条与统一计费准入合同冲突的旧断言，
  最终完整结果为 154/154 PASS，不把环境失败或旧断言写成通过。
- Web Chromium 全量 **27/27 PASS**，真实完成“于滔 → DeepSeek →
  `ql-deepseek-v4-flash`／`ql-deepseek-v4-pro` → 请求明细”并访问独立项目账。
- Gateway 通过 Codex CLI 0.147 alpha 完成 2 次真实 Responses／上游调用；均为 `SUCCEEDED`，
  每笔 input 120、output 32、cache 20、reasoning 8，API cost `0.00015200`。

### 定向回归

| 修复范围 | 结果 |
| --- | ---: |
| half-open runtime／超时装配 | **7/7 PASS** |
| W11 真实 PostgreSQL probe 接管与 fencing | **6/6 PASS** |
| W18 真实 PostgreSQL 撤权、结算与回滚 | **23/23 PASS** |
| failover 后备用候选前置拒绝真实 PostgreSQL 回归 | **修复前 500；修复后 403／FAILED／唯一 transaction PASS** |
| POOL-043 Gateway 结算回归 | **9/9 PASS** |
| Database 撤权结算、锁序与幂等 | **57/57 PASS** |
| Domain billing rule | **31/31 PASS** |

### 迁移、覆盖率与变异测试

| 范围 | 结果 |
| --- | --- |
| 0043 真实 PostgreSQL | PASS |
| 0042→0043→0044 up/down/replay | PASS |
| Runtime Assurance 0044→0043→0042 | PASS |
| POOL-043 Database + Control API coverage | 120/120；99.61 statements / 92.67 branches / 100 functions / 99.61 lines |
| POOL-043 Gateway coverage | 74/74；97.79 / 89.20 / 100 / 97.79 |
| POOL-043 Web coverage | 40/40；97.34 / 85.84 / 91.73 / 97.34 |
| 13-scope coverage ratchet | PASS，无回退 |
| Resource fencing mutation | 29 mutants；29 killed、0 survived、0 no-coverage，**100%** |
| Database mutation | 473 mutants；414 killed、44 survived、15 no-coverage，**87.53%** |
| Gateway POOL-040 mutation | 136 mutants；136 killed、0 survived、0 no-coverage，**100%** |
| Gateway POOL-043 mutation | 108 mutants；98 killed、9 survived、1 no-coverage，**90.74%**；新增终态 helper **23/23 killed** |
| Domain mutation | 752 mutants；667 killed、72 survived、13 no-coverage，**88.70%**；新增 matcher **26/26 killed** |

- mutation disposition 门禁已通过；Database 的 44 survivor／15 no-coverage、Gateway POOL-043 的
  9 survivor／1 no-coverage、Domain 的 72 survivor／13 no-coverage 均已登记，且本轮新增计费
  matcher 26/26 killed、新增终态 helper 23/23 killed，未增加这两条路径的变异债务。本地报告分数
  均不低于 80%，但这些残余登记与本地测试不能代替最终双审，也不构成部署完成声明。

### 工程门禁

| 门禁 | 结果 |
| --- | --- |
| 11 workspaces typecheck / lint / build | PASS |
| architecture | PASS；340 个生产源文件，无 runtime cycle |
| source size | PASS；248 files，默认不超过 400 逻辑行 |
| duplication | PASS；0.85%，低于 5% |
| production dependency audit | PASS；无已知漏洞 |
| license allowlist | PASS |
| `git diff --check` / release script `bash -n` | PASS |
| evidence canary logs 子项 | PASS；但 full scan 明确为 false |

## 发布保护与剩余 Evidence Gap

- 发布脚本只接受已上传 GitHub `main` 的精确 40 位 SHA；Mac Mini 从 GitHub detached checkout，
  不从本机脏工作区复制文件。
- 脚本要求生产数据库严格处于 0042，停写后再次核对迁移 blocker，生成并校验 `pg_dump`，再执行
  0042→0043→0044；验证关键列、唯一索引和外键后才启动新应用。
- 迁移前失败可恢复旧镜像；迁移后失败保持业务服务停止，必须先从备份恢复 0042，禁止旧应用在
  0044 上继续写入。
- **Evidence Gap（非本地候选代码阻断）**：生产部署、生产规模迁移耗时、POOL-039／043 生产业务
  验收以及 POOL-040／041 的真实 reserve 后撤权／重复输入验收尚未执行。
- **Evidence Gap（当前阶段阻断）**：P1 整改后候选尚未重新冻结，最终两位独立 Reviewer 尚未对
  新对象执行；
  因此当前不允许把本文件解读为最终 PASS，也不允许据此提交、上传或部署。
- **POOL-042 仍阻断 v1.0 全局封板**：canary 尚未覆盖 PostgreSQL、Redis 与 Trace，DeepSeek API
  资源摘要的 Token 与余额可承载 Token 估算也尚未实现；本候选不修改该功能范围。

## 阶段准入

- **当前不允许提交、上传 GitHub、部署或进入业务验收。**
- 整改后候选重新冻结且两位独立 Reviewer 均 PASS 后，才允许提交并上传 GitHub。
- GitHub `main` 精确落点核验通过后，允许执行 Mac Mini 发布脚本。
- 只有生产迁移、健康检查和真实业务验收均通过，才能把 POOL-039／040／041／043 更新为关闭；
  POOL-042 未修复前不得宣称 v1.0 已完整封板。
