# 发布前置 1-4 处理记录（2026-11-06，用户授权"依次处理"）

执行：总指挥 GLM-5.3（本会话）＋glm-flash 三轮委派（脚本定制/折单优化/闭环演练），全部独立复跑/复审。基线：30ae2aa → 本轮三笔提交（见文末）。

## 1. W20-10 四项 P95 —— 达成 ✅

- 现状实测（标定环境，隔离×2）：resourceUtilizationP95 **1143 / 1175ms** 稳定超 1000ms 门（N+1 已由 30ae2aa 消除，残余＝批量版 3 条语句各扫一遍百万行 ledger_line 的固有成本）。
- 处置（终审备选路线 b，纯代码）：`loadApiCostEstimationByResource` 折成单条 SQL——MATERIALIZED CTE 单次基表扫描＋unnest 驱动 LEFT JOIN 三子聚合（计数/币种 SUM jsonb/依据 DISTINCT jsonb），输出逐字段等价（30ae2aa 的三条一致性用例护栏全绿）。
- 复测：**2/2 全 PASS**（提交 `7d28c4a`）。未用路线 a（0097 索引，避免新迁移）与 c（判据分档，涉降阈值）。
- 遗留：GitHub CI 复验待分支推送（推送需用户决定时机）；若 CI 硬件仍超线，升级路线 a（0097 复合索引）再议。

## 2. 备份建立＋制品格式统一 —— 达成 ✅

- 格式裁定（release-candidate §4.2 留白项）：**统一 pg_dump -Fc＋pg_restore**——发布脚本先例的非空/防覆盖门均建在 -Fc 上，且支持并行恢复与 TOC 校验。
- 新增 `deploy/scripts/backup-pre-api-decouple-20261106.sh`（On the production host；只读 pg_dump；防覆盖/非空/TOC 三道门；结尾回显迁移头；无任何写表/重启）。
- 隔离实证：623,786 字节 dump、TOC 与 head=0091 回显正常。
- **生产执行待运维**：发布窗口由操作员在主机跑 `--backup`（届时数据已前进，会取到新备份；本次演练件仅证机制）；deployment_log.backup_ref 登记属发布流程，不在本轮。

## 3. rollback.sh 期望头按 0091 定制 —— 达成 ✅

- 期望头 `0045` → `0091_recorded_cost_accounting_policy`（生产实际水位，§8.1 回执）；消费格式 `.sql.gz` → `-Fc`（容器内 pg_restore --list 完整性门，docker cp＋pg_restore -j4 恢复）；门置于就绪后/dropdb 前。
- **演练抓出并修复生产级缺陷**：原 pg_restore 缺 `-U "$POSTGRES_USER"`——容器以 root 落地走 socket 连不存在的 role "root"，**生产回退会先 dropdb 清库、再恢复失败**。根因唯一性经对照实验实证（仅加 -U 即成功）；修复带注释入档。

## 4. 生产恢复闭环核对 —— 达成 ✅（隔离演练两轮）

- 路线：0091 水位库（latest 后 down×5）＋种子 → 备份 → 备份后写入 → YES 回退 → 负向×2。
- ROUND 1：8/9 过，step6 FAIL＝上述 -U 缺陷（保留历史）。
- ROUND 2（修复后）：**全 PASS**——回退 exit 0、head=0091、种子复原、备份后写入被清（DESTRUCTIVE 语义正确）、坏备份门 exit 1 库未动、NO 确认提前退出。
- 证据：`V4/Evidence/API-COST-OFFICIAL-BALANCE/PRECOND-20261106/`（drill.log 463KB 两轮全程＋result.json verdict=PASS）。

## 提交

- `7d28c4a` perf(database): fold batch estimation into single ledger scan
- （本轮第二笔）deploy: pre-release backup script + rollback.sh 0091/-Fc/-U 定制＋演练证据

## 剩余（非本轮范围）

生产侧动作均待"发布实施"任务：主机执行备份、W20-10 的 CI 复验（分支推送后）、deployment_log 登记、切换/回退实际执行。
