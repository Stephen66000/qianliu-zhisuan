# EG-03/EG-04 待确认方案（本轮只提交方案，不执行）

## EG-03：Bash 回退脚本等价验证方案（隔离临时副本变异）

对象：`deploy/scripts/rollback-delta-20261106.sh`（真实脚本零改动；在 /tmp 隔离副本上做人工变异，每变异跑既有断言桩）。

| # | 变异点（人工改副本） | 应杀死的既有断言（CODE-QUALITY-V15-20261107/red-evidence green 20 用例） | 预期 | 预计耗时 |
|---|---|---|---|---|
| B1 | 删除 `DB_LIVE` 非空检查 | 负向组"缺 --db-live"→ 应 exit≠0 零容器调用（现桩证） | 桩捕获到容器调用＝变异存活→断言杀死它 | ~2' |
| B2 | `DB_SHADOW != DB_LIVE` 改 `!=` 为 `==`（同名放行） | 同名拒绝组（restore/replay/retire/verify/swap 五入口） | 至少一入口发出破坏调用 | ~3' |
| B3 | keep≠live 检查删除 | keep 冲突组 | swap 对 live 名改名 | ~2' |
| B4 | ref==live 检查删除 | verify live==ref→exit 3（返工新增） | 空洞 verify OK | ~2' |
| B5 | 守卫移到 dropdb 之后（顺序变异） | "任何破坏前拒绝"——负向组捕获目录零 argv 断言 | 负向出现容器调用 | ~2' |
| B6 | manifest_done 校验删除 | replay 幂等/失败保护组（J/K 用例映射的桩子集） | 未完成清单被回放 | ~2' |

合计 6 变异×（改副本+跑桩）≈ 15 分钟；执行产出＝逐变异 killed/survived 表＋日志，全部入 run2/eg-03/。**等待验收人确认后执行**；真实脚本、生产库零接触。

## EG-04：复杂度/CRAP 等价证据方案（不加新插件）

现有工具可提供：ESLint cyclomatic（complexity≤30＋文件例外，lint 全绿）＋本轮 eg02 覆盖率（v8 逐文件/逐行 json）。等价风险评估方法：
1. 从 eg02 coverage-final.json 提取核心文件**未覆盖分支清单**（已知：refresh-repository 85.47% stmt＝防御性不可达分支为主，见 EG-02 遗留 2）；
2. 高风险函数清单＝6 核心文件中 cyclomatic≥15 或分支覆盖＜90% 的函数（eslint --format json 可离线产 per-function 复杂度，不改配置）；
3. CRAP 近似＝complexity²×(1-覆盖率)（原公式），逐函数列值＋处置（补测/防御不可达说明/等价）；
4. 认知复杂度：无工具，等价声明＝以"嵌套深度＋布尔子句计数"的 eslint 可观测代理指标＋人工抽查 5 个最复杂函数，**不冒充认知复杂度数值**。
产出＝run2/eg-04/ 的函数级表。~20 分钟。**等待确认后执行**。

## 状态

两个方案均为**已提交待确认**，不记为门禁通过；EG-01/02 已完成的实绩见 gate-remediation-report.md。

---

# 执行结果（2026-11-07，验收人批准后）

## EG-03 已执行（证据 run2/eg-03/）

| 变异 | 结果 | 说明 |
|---|---|---|
| B1 删 live 非空检查 | **KILLED** | 6 负向例破坏完成 exit0（dropdb 落 live 名） |
| B2 删 shadow≠live | **KILLED** | 5 同名例放行 |
| B3 删 keep≠live | **SURVIVED＝构造性冗余** | keep==live ⇒ keep 名必存在 ⇒ 既有存在性检查（die 9）先行；破坏仅及合法影子清理 |
| B4 删 ref≠live | **KILLED** | neg-verify-live-eq-ref 空洞通过 |
| B5 守卫移破坏段后 | **KILLED** | dropdb/createdb 已执行后才拒绝＝破坏先于防护 |
| B6 删 manifest_done grep | 既有断言 SURVIVED＋**专项实测冗余兜底成立** | 验收人怀疑属实：20 桩用例无缺-done 场景；实测无 done 清单在原版与变异版**均 exit6 拒绝**（下游 sha256 一致性检查兜底）——行为级 fail-closed 保持；建议补 neg-no-done-manifest 桩用例（待批准） |

## EG-04 已执行（证据 run2/eg-04/crap-table.txt）

- 公式已按验收人修正：**CRAP＝c²(1−cov)³+c**（cov 0–1）。
- 取数：复杂度＝eslint `--rule complexity:0` 内联逐函数上报（不改配置文件）；覆盖＝istanbul coverage-final.json 函数计数器（**调用布尔口径，如实标注**，非连续比例；未用文件级冒充函数级）。
- 结果：41 函数、26 个成功配对计算；**无"未调用×高复杂度"项**（配对函数全部被调用，CRAP=c）；复杂度热点：sync-writes L20 **C=17**（即 EG-02 遗留 2 的注释/FK 观察文件）、runner L101 C=14；15 个未配对（箭头函数/行偏移）如实 N/A。

## EG-02 幸存对账（验收人口径确认；证据 run2/eg-02/survivor-reconciliation.txt）

原始终报告 208/201/7。7 幸存逐 ID：**等价 3**＝id0（estimation:166 默认参数，投影固定列不变）、id61（:377 空清单早退，空 Map 同构）、id175（states:174 相等时刻比较器，同值同刻）；**非等价 4**＝id16（estimation:250 缺口计数聚合）、id174（states:174 双候选 reduce 条件）、id206/id207（states:205 排序比较器×2）。最小补测方案：①id16＝夹具加"已计价但 currency NULL"行，断言缺口分类不并入 not_migrated；②id174＝同资源两条不同 next_refresh_at 候选，断言取值符合合同；③id206/207＝输入显式乱序插入，断言输出排序稳定（不依赖 SQL 自然序）。**执行待授权（本轮只对账）**。
