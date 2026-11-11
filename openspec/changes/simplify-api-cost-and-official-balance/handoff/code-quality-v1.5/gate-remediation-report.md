# 门禁整改报告（EG 轮，2026-11-07）

依据：`交接/V1.5代码质量预检-20261107/zcode继续补齐门禁-测试与配置限定整改指令.md`（限定测试/配置授权）。原 P1-P4 编号改为证据问题 ID（EG-01/02/03/04），与产品缺陷分级区分。

## 1. 对象与预算

- 起点 HEAD `7594639`（锁 STABLE 核实）→ **本轮测试/配置整改提交：见 git log（本报告随批提交）**。
- **生产实现零改动实证**：`git diff 38ab493 -- apps packages deploy V3 package.json pnpm-lock.yaml ':!**/*.test.*' ':!**/__tests*/**'` 仅余本轮**测试/配置**文件（清单 §2/§3）；生产 src 非测试文件 0 改动（逐文件核对）。测试/配置已变→**不再宣称 implementation_hash 不变**；对象锁全量重锁（§6），生产实现未改单独以上述 diff 证明。
- 预算：Contract 新增 1 个限定测试/配置批次（授权见指令 §2）；墙钟累计约 375'/420'（补证 235'＋EG-01 约 20'＋EG-02 107'＋复核/收尾约 15'）。fix_batches：整改 1＋测试/配置 1；复审轮 0/2 未动。

## 2. EG-01：pool029 修复（原 P1）——完成 ✅

- **根因（修正 run1 过度结论）**：非配置语义差异——w05 夹具的 `principal_grant` 依赖 DB 默认 `now()`（colima VM 时钟快 +1.5s 且周期回拨），授权查询用宿主 JS 时钟过滤 `valid_from`→种子落"未来"1.5s 窗口内被过滤。因果实验（夹具加 2.5s 延迟→33/33）＋配置逐项对比（无可解释差异）实证；标准配置当时 33/33 属时钟相位幸运，两配置失败机制相同。
- **修复**：w05 测试夹具 +2 行（grant 显式 `valid_from: new Date(0)`，与同文件 billing_rule 惯例一致）；未删用例/未 mock/未动阈值。
- **验证**：pool029 配置全池 9 文件 90/90；标准配置 33/33；node/web 两段分别 exit 0＋两份 coverage-summary 生成（97.74/90.31 等）；**ratchet exit 0 "13 scopes did not regress"**（总指挥独立复跑同判）。
- 证据：run2/eg-01/（repro/因果/a-d 四段）。**修正记录**：gate-supplement-report 中"配置上下文型/预存"表述已按本轮根因改写。

## 3. EG-02：新模块覆盖＋定向变异（原 P2）——完成（余 3 条幸存有计划）✅

- **映射表**：run2/eg-02/mapping.md（高风险逻辑→文件含拆分落点→测试→配置→阈值依据；X07 拆分产物标注集成回归覆盖不进变异）。
- **覆盖率**：新根配置 `vitest.eg02.config.ts`（8 既有＋1 新增测试；覆盖 6 核心文件）——TOTAL **96.74/93.68/96.15/96.74 全部≥V3 全局阈值**（总指挥独立复跑同值，60/60）；文件级无已批阈值者仅观测（refresh-repo 85.47% 语句＝防御性不可达分支，见遗留）。
- **变异**：`stryker.eg02.database.config.json`（mutate＝api-cost-estimation＋official-balance-states；未弱化算子/未排除核心逻辑；阈值沿用 database 域既有 break 80）：208 mutants，两轮后 **96.63%（exit 0，总指挥独立复跑同分）**；幸存 7→**4 条本轮补边界测试杀死**、**3 条等价（逐条语义依据：默认参数不影响投影/空清单空 Map 同构/比较器相等时刻同值）**、**3 条非等价幸存**（仅-CURRENCY_MISSING 场景、双候选 next_refresh_at、排序判别力受限——kill 计划已列，本轮预算尽顺延，如实 OPEN）。
- **新增测试**：fallback 单测 3＋刷新幂等 2＋runner 三分态 1＋listLatest 1＋边界/排序 1（全绿，typecheck 0）。
- 证据：run2/eg-02/（mapping/coverage 两轮/stryker 两轮 json/脚本）。

## 4. EG-03/EG-04：Bash 等价验证与复杂度方案（原 P3＋Bash 部分）——**方案已提交待确认**

见 `eg03-eg04-plans.md`：Bash 6 变异×既有桩断言映射（~15'，隔离副本，真实脚本零接触）；复杂度/CRAP 等价＝eslint per-function＋eg02 覆盖逐函数 CRAP 近似＋认知复杂度代理指标（不冒充数值，~20'）。**不记为门禁通过**。

## 5. 总指挥独立复核

- 范围：git diff 逐文件＝4 测试改＋4 测试/配置新增＋w05＋2 行＋证据/文档；生产 src/V3/迁移/lockfile 零改动（两次核对）。
- 亲跑：ratchet exit 0；eg02 覆盖 60/60（四项达标）；stryker 96.63% exit 0；source-size 695 文件 exit 0；architecture exit 0（config 新增后复验）。
- 纠错一次：本人首次复跑 eg02 漏 DOCKER_HOST 致容器策略失败——环境调用错误非代码问题，带全环境复跑通过（记录在案）。

## 6. 对象锁

- 本批提交后全量重锁＋verify（测试/配置变更纳入；三组哈希以 candidate-lock.json 为准）。生产实现未改由 §1 diff 单独证明。

## 7. 开审状态

- 已补齐：pool029＋ratchet、新模块覆盖率、定向变异（3 条幸存 OPEN）。
- **待确认（开审阻断候选）**：EG-03 Bash 方案、EG-04 复杂度方案、变异 3 幸存 kill 计划、EG-02 遗留 2（sync-writes 注释与 FK 现实不一致——注释级观察，未修）。
- 审核状态 **NOT_STARTED** 维持；握手不执行。
