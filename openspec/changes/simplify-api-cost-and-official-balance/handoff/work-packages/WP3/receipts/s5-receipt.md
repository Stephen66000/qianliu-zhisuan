# WP3 S5 回执：恢复链回归＋预测/告警来源与时效校正（task 3.4）

实施：glm-flash；日期：2026-11-03；基线＝S2+S3+S4 工作树（未提交）。`recordBalanceSyncRecovery`（resource-pool-repository.ts:252-273）与 runner 两个恢复调用点（recoverFromFreshPositiveBalance/recoverFromFetchedBalance）本阶段**零编辑**（git diff 复核）。

## 1. 实际改动文件清单

| 文件 | 改动 |
|---|---|
| `packages/domain/src/supply-forecast.ts` | 新增两个 reason 常量（`official_source_missing`/`official_balance_expired`，开放 string 通道集中枚举）；computeForecast 数学零改动 |
| `packages/domain/src/index.ts` | 导出常量 |
| `packages/domain/src/__tests__/supply-forecast.test.ts` | +2 用例（常量冻结＋余额未知既有行为钉死） |
| `packages/database/src/repositories/provider-operating-repository.ts` | 新增 `listLatestOfficialOperatingSnapshots`/`listCurrentOfficialOperatingSnapshots`（PROVIDER_SYNC 过滤变体，投影复用既有 projectCurrentOperatingSnapshots）；既有两函数语义零改动 |
| `packages/database/src/repositories/supply-forecast-repository.ts` | runTick 增加 `expireMs` 参数（缺省镜像 P2 冻结默认 30min；生产值经 worker 注入）：**仅 API 模式**走官方来源（listCurrentOfficialOperatingSnapshots）＋时效门禁；来源不合格（有任意快照无官方来源）→ `official_source_missing` 不可计算行；超 P2 → `official_balance_expired` 不可计算行（exhaust_at/rates/remaining 恒 null，不按旧值/手工值算确定耗尽时间；同 bucket 幂等 onConflict）；无任何快照维持既有跳过；**CODING_PLAN 套餐额度预测保持既有输入与行为**（ADMIN 套餐快照属 W5/W6 配置域，非官方余额；OAB-07 文义限定"API 余额告警与耗尽预测"） |
| `apps/worker/src/supply-forecast/runner.ts` | runSupplyForecastTick 注入 `readProviderOperatingBalanceExpireMs(process.env)`（database 不依赖 config 包） |
| `packages/database/src/__tests-integration__/wp3-supply-forecast-official-source.integration.test.ts` | 新建 4 用例（§4） |
| `packages/database/src/__tests-integration__/pool022-supply-forecast.test.ts` | 夹具按新口径机械调整（合同 pool010 同款原则）：API 资源两处快照 ADMIN→PROVIDER_SYNC＋balance_source=PROVIDER_API＋采集时刻新鲜化至 now-2min（24h 旧快照在新 P2 口径下属过期——这正是 OAB-07 要拒绝的输入）；**全部断言原样保留**；CP 夹具保持 ADMIN（域不变） |

## 2. 命令与用例数

| 套件 | 结果 |
|---|---|
| **恢复链回归**（合同 §1） | worker runner.test **3/3**（恢复三态断言）＋worker 静默集成 **3/3**＋domain resource-lifecycle **30/30**（deriveBalanceSyncRecovery 专项在内；S1 记录 28 it→上游已增至 30，非本包改动） |
| **WP2 准入回归**（AT-OAB-11） | gateway w11-resource-pool＋wp2-pending-admission **12/12** |
| domain supply-forecast.test | **16/16**（新增 2） |
| pool022（夹具适配后） | **1/1** |
| database 新预测套件 | **4/4** |
| database 汇总批：pool010＋pool022＋wp3 forecast/states/refresh/decouple | **27/27**（pool010 5：夹具本就 PROVIDER_SYNC，零调整，`forecast_exhaust_risk`/告警断言全绿） |
| insights 回归 w20-resource-insights | **9/9** |
| worker 全量 battery | **36 文件 200/200** |
| worker/database/domain typecheck＋lint | 0 错误 |

## 3. AT-OAB-11 机制层结论（grep 证据）

- `grep -rn "official-balance|officialBalance|listOfficialBalanceStates|OfficialBalanceRefresh" apps/gateway/src` → **零命中**（gateway 不 import 任何本包新增模块）。
- 准入路径输入源核实：`listServableResources`（resource-pool-repository.ts:429）→ `evaluateAdmission(toRuntimeState(row), now)`（:447）→ domain 状态机（resource-lifecycle.ts:306），输入仅 provider_resource 行状态字段——**无任何余额/快照/attempt 读取**。
- 新增模块消费方全列（grep import 链）：仅 `apps/control-api/src/providers/routes.ts`（C2 读挂载）、`official-balance-routes.ts`（刷新端点）、database index/kysely 导出。**结论：本包改动不新增任何调用准入条件、不触发自动换厂商（OAB-06/07 禁止项零违反）；恢复链行为与准入门禁完全解耦。**

## 4. 新测试用例（6 用例）

database 预测（4）：a) 仅 ADMIN 快照→`official_source_missing`＋exhaust/rates/remaining 全 null＋同 bucket 幂等；b) 官方快照超 P2→`official_balance_expired` 无确定 exhaust_at＋新官方快照（P2 内）→正常路径（no_consumption_rate，remaining 55 保鲜）；c) 来源优先级（官方 50 新鲜 vs 更新的 ADMIN 999→预测用 50）；d) CP 套餐 ADMIN 快照照常计算（800＋no_consumption_rate 正常路径，未企业过滤误伤验证）。
domain（2）：reason 常量冻结＋余额未知既有行为钉死。

## 5. insights 15min 替换结果：**报备保留硬编码（裁定 B 停下报备路径）**

`resource-insights/query.ts:296` `sf.snapshot_at >= now() - interval '15 minutes'` 判定对象是 **supply_forecast 行（预测产物）的新鲜度**（`is_current`＝预测行 15min 内＋晚于快照＋余额匹配，:294-303），度量的是"预测 tick 是否刚跑过"；而 P2 判定的是**官方余额采集时效**（快照 `collected_at`）。二者度量对象不同：替换会把"预测产物滞后"误标为"官方余额有效"（例：官方余额已过期但预测 15min 内刷新过 → is_current 仍 true）。**按合同指令保留硬编码＋记录差异依据**，w20-resource-insights 9/9 回归绿。若 WP4/后续需要把官方时效带入 insights，应作为新增字段（official_balance.expired 已可从 C2 读取获得）而非替换该阈值。

## 6. 剩余问题 / 移交

1. runTick `expireMs` 缺省值（1.8M）是 P2 冻结默认值的镜像——database 不依赖 config 包，生产值由 worker wrapper 注入；直接调用 repo 的其他路径（当前无）需自行传参。已注释说明。
2. pool022 API 夹具新鲜化（24h→2min）：依据＝OAB-07 新口径下 24h 旧官方余额属"过期输入"；断言未动。
3. CP 预测保持 ADMIN 输入的裁定依据：OAB-07 文义限定 API 余额域；CP 套餐配置属 W5/W6（WP3 红线不动）。如总指挥认为 CP 也需来源门禁，需先裁 W5/W6 合同边界。
4. dispatch-operating-input（调度比例）仍消费全来源快照——不在 OAB-07 文义（调度非预测/告警）且合同未列；如需校正请裁定归属。
5. 非浏览器联调锚点（AT-OAB-11/13/14 展示层）待 WP4/WP5。
