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
