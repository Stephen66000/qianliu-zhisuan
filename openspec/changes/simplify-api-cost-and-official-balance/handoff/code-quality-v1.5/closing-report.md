# 收尾报告（T1-T6＋EG-04，2026-11-07）

授权：`交接/V1.5代码质量预检-20261107/zcode收尾指令-T1-T6与EG-04.md`（新增 1 测试整改批次，追加 ≤110'，累计上限 530'）。

## 1. 对象与预算

- 起点 HEAD `1447ade`（锁 STABLE 核验）→ 收尾提交：见 git log（随本报告提交）。
- 生产实现与 `38ab493` 一致性：生产面（apps/packages 非测试 src、deploy、迁移、V3、lockfile）**diff 为空**（T1-T5 产出 production-zero-diff.txt 快照＋总指挥提交前复验）；本轮改动＝2 测试文件（+102/−3）＋run-probes.sh 桩用例（+8）＋证据两目录＋文档。
- 预算：收尾批实际 **约 35'（子 Agent）＋约 20'（EG-04/总指挥）＋复验约 20'** ≈ 75'（≤110'）；累计约 **490'/530'**。

## 2. T1-T5 结果（证据 run2/eg-05-t1-t5/）

| 任务 | 结果 | 变异命中 |
|---|---|---|
| T1 币种缺失 | 夹具"已计价币种 NULL"（0085 shape 下唯一可写路径）→ 断言 KNOWN_PARTIAL＋gaps==[{CURRENCY_MISSING,1}]＋不误归 NOT_MIGRATED | **id16 KILLED**（killedBy=test#10；手工变异实验 exit1 留档） |
| T2 双候选 | 冷却 now+25s（前位）vs 租约 now+10s（后位），较早在后→选 last 必败；断言 next_refresh_at=较晚 | **id174 KILLED**（test#33） |
| T3 排序 | 800 资源显式降序插入（小表 PK-scan 恒升序＝基线幸存根因，已实证）＋前提自证查询；断言输出升序 | **id206＋id207 同一测试双杀**（test#34） |
| T4 B6 桩用例 | run-probes 绿组 +neg-no-done-manifest（21 例）：exit6"缺 manifest_done"、未发回放 SQL、唯一破坏调用仅指 shadow_ok、容器可达非前置失败；既有 20 例零漂移 | 桩层固化 |
| T5 复跑 | 定向 41/41（总指挥独立复跑同）；**Stryker 208/205/3＝98.56%**（四变异按文件/位置/替换映射全杀；3 等价幸存依据保留）；estimation/states 100/100/100/100；eg02 总覆盖 96.74/94.24/96.15/96.74；ratchet 13 scopes 过 | 总指挥独立 stryker 复验结果见 §5 |

**变异映射表**：id16（estimation:250 末位＋→−，KILLED by T1）；id174（states:174 条件→false，KILLED by T2）；id206（states:205 sort→恒等，KILLED by T3）；id207（比较器→undefined，KILLED by T3 同测试）。3 等价＝id0/61/175（默认参数投影不变/空清单同构/并列时刻同值）。

## 3. EG-04 函数级取数（证据 run2/eg-04/fn-stmt-crap-table.txt）

- 方法：语句按中点行归属**最内层**函数区间（嵌套不重复计入）；比例＝函数区间内已覆盖/可计数语句；代理值＝C²(1−语句覆盖比例)³+C（**语句覆盖代入的代理，明确标注**）；调用计数仅辅助。
- 结果：**41/41 配对（前轮 15 缺口全部补齐，无新缺口）**；代理值>30 的 0 个；**唯一真实信号＝`isUniqueViolation`（refresh-repo:35）C=5、语句覆盖 0/10、代理 30.0**——即 EG-02 已登记的"防御性不可达"唯一约束竞态兜底分支；部分覆盖：routes 131/136、begin 59/66、replayResponse 9/11；其余全 1.00。

## 4. 异常与登记项

- **并发 worktree 改指异常**（15:45-15:48，约 2 分钟 HEAD 两度显示旧提交 9a5fd56 后自行复原；anomaly-concurrent-worktree-flip.txt）——非本批操作；建议该 worktree 会话串行化（上报用户）。
- colima 由子 Agent 拉起（开工时未运行）；T3 夹具 N=800 使 stryker 时长 14'32"（可裁定行数下限）。
- sync-writes 注释失实＝仅登记（待确认后按文档问题处理）。

## 5. 总指挥独立复核

- 定向套件 41/41 亲跑；stryker 独立复验（stryker-run-commander.log）：**exit 0，mutation score 98.56%＝与子 Agent 运行一致**（208/205/3；幸存＝3 等价项，四非等价确认全杀）。
- 变更范围逐项核对＝授权清单内；生产面零改动复验；B6 旧废档保留＋有效档在档。

## 6. 状态

- T1-T6＋EG-04 全部完成；**正式审核 NOT_STARTED 维持**，开审条件核验交回验收人。
- 剩余待决（开审条件候选）：isUniqueViolation 等防御分支的覆盖认定（建议按"防御性不可达＋兜底语义"接受或另行授权测试）、sync-writes 注释处置、T3 夹具耗时裁定。
