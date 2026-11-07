# 门禁补证与纠文报告（gate-supplement，2026-11-07）

依据：`交接/V1.5代码质量预检-20261107/zcode门禁补证与正式开审准备指令.md`（补证阶段，非整改授权）。执行：总指挥 GLM-5.3（本轮全部命令亲跑，未委派——纯运行工具与记录）。

## 1. 对象与运行时

- 分支 `codex/simplify-api-cost-and-official-balance`；**实现提交 `38ab493`**（最后一笔代码）；**送审材料提交 `cefbb6d`**；补证材料提交见 §6（本轮新增，纯文档/证据，不改实现——由对象锁 implementation_hash 与实现提交树一致佐证）。
- 接手核验：HEAD=cefbb6d、旧对象锁 verify=STABLE（81e275de…）、工作树仅锁文件自身未跟踪（工具自排除）。
- 运行时：**Node v22.23.4（每批日志回显）＋corepack pnpm@11.11.0**；集成环境 DOCKER_HOST=colima＋RYUK disabled（仅隔离容器）。
- 实现文件未修改核对：本轮 `git status` 全程仅新增证据目录与文档编辑；`git diff 38ab493 -- apps/ packages/ deploy/ V3/ package.json pnpm-lock.yaml` 为空（待终验记录）。

## 2. 补证执行表与结果（证据根：`V4/Evidence/API-COST-OFFICIAL-BALANCE/CODE-QUALITY-V15-20261107/gate-supplement-run1/`）

| 门禁 | 脚本（既有） | 结果 | 退出码 | 证据 | 备注 |
|---|---|---|---|---|---|
| build×3 受影响包 | `--filter <pkg> run build` | PASS | 0/0/0 | batch-a.log | web=vite 真实产物（dist/index.html 11-07 新鲜）；control-api=tsc 产出含 GATE-01 拆分新模块 js；database 脚本本身 noEmit 型（项目定义如此，如实记录） |
| 重复率 | `quality:duplication`（jscpd 5.0.14，min-lines 20/min-tokens 100/threshold 5） | **PASS**：clone 0.49-0.62%＜5%（26 处克隆） | 0 | jscpd.log | **纠正**：上轮"缺工具"失实 |
| 依赖漏洞 | `audit:prod`（--prod --audit-level moderate） | **PASS**：No known vulnerabilities | 0 | audit.log | 联网正常；**纠正**：上轮"未配置"失实 |
| 许可证 | `quality:licenses`（list --prod --json → check-licenses.mjs） | **PASS**：license gate passed（MIT/Apache-2.0/BSD/ISC 等） | 0 | licenses.log | 管道两段均成功；**纠正**：上轮"未配置"失实 |
| 覆盖率全池 | `quality:coverage`（链式） | **FAIL（链断）** | 1 | coverage-all.log | 断点＝gateway `w05-northbound.test.ts` 4 例（/v1/models 形状）；**鉴别**：该文件与北向/模型目录源码本阶段零触碰（git log 核实）、**同文件独立复跑 33/33 全过**→判为池配置上下文/环境型失败，非代码回归；未修任何配置 |
| 覆盖率逐池 | 六池逐一单独跑 | domain/changed/pool030/pool040/pool043 **PASS（exit 0，报告产出）**；**pool029 FAIL（exit 1：w05-northbound 6 例）** | 0×5/1 | batch-b2.log＋cov-*.log | pool029 第二段（web）因首段失败未跑 |
| ratchet | `quality:coverage:ratchet` | **FAIL**：仅缺 pool029-node/web 两份报告（ENOENT）；其余池报告齐全已比对 | 1 | ratchet2.log | 被 pool029 失败阻断 |
| 增量变异（适用性核查） | stryker 既有配置盘点 | **无适用配置（OPEN）** | — | 本报告 §3 | pool039（26+2 文件）/pool043（8+6）/pool021-r2（1）均不含本阶段新模块与拆分产物（grep 实证：api-cost-estimation/official-balance/rollback-delta/四个拆分模块零命中）；本轮不新增配置（指令红线），最小方案见 §4 |
| 复杂度 | eslint complexity（lint 内） | PASS（lint 0 含该规则） | 0 | 前轮记录 | 认知复杂度/CRAP：现有工具不提供→OPEN |
| typecheck/lint/source-size/architecture | 既有 | PASS（前轮 Node 22.23.4 亲跑，验收人已独立确认，复用不重跑） | 0 | gates-evidence.md | 候选未变（实现同一性成立） |

## 3. 新模块门禁覆盖差距（如实，OPEN）

- **无变异配置**：0093-0096 域新模块（api-cost-estimation、official-balance-states/sync、rollback-delta 脚本）与 GATE-01 拆分产物均不在任何 stryker 配置内。旧 pool039/043 报告不能替代（指令明示）。
- **覆盖率扫描范围**：现有池不含上述新模块（`changed` 段为固定旧文件清单）——即覆盖率证据对高风险新逻辑**覆盖不足**，即使池全绿也不代表新模块有覆盖证明。
- **bash 回退脚本**：无现成变异/覆盖率工具（shell 域）。
- 认知复杂度/CRAP：无工具。

## 4. 待决问题统一表（不自行修，待裁定）

| # | 问题 | 影响 | 需改代码/配置？ | 最小建议动作 | 阻断？ |
|---|---|---|---|---|---|
| P1 | w05-northbound 在 pool029 配置下失败（链跑 4 例/单池 6 例/**单文件过滤仍 4/33**）而标准集成配置独立跑 33/33 全过——排除顺序干扰，坐实 pool029 配置环境差异（该配置明含 w05 于 include） | pool029 两报告缺失→ratchet 阻断 | 需查 pool029 配置 env/fixture 差异（可能涉测试/配置修改） | 对比 vitest.pool029.config.ts 与标准 config 对 w05 相关 env 的差异并修复（授权后进行）；本阶段 w05 与北向源码零触碰（git 核实） | **ratchet 门禁阻断**（开审阻断候选） |
| P2 | 新模块无变异/覆盖配置 | 高风险逻辑缺变异与覆盖证明 | 需新增 stryker/coverage 配置（授权项） | 最小方案：为 api-cost-estimation＋official-balance 域各建一个增量 stryker 配置＋纳入 changed 清单；bash 脚本建议以桩断言回归替代（已有 20 桩用例可作等价证据提请认定） | **开审阻断候选**（V3 将变异列为必需门禁）——由验收人裁定 |
| P3 | 认知复杂度/CRAP 无工具 | 模板域证据缺 | 需新增依赖/工具（授权项） | 建议 eslint-plugin-sonarjs 或等价；本轮不装 | 非阻断（无既有阈值） |
| P4 | database build 为 noEmit 型 | "build 产物"证据弱（仅类型构建） | 否（项目自身定义） | 如需产物级 build 证据须改脚本（授权项）；现按脚本定义记录 | 非阻断 |

## 5. 纠文清单

1. gates-evidence.md：#11 重复率、#13 漏洞/许可证 由"缺工具/未配置"改为"已运行 PASS（脚本存在，前轮记录失实）"；#8/#9/#12 按本轮实况改写；保留历史行注明"前轮误记，本轮纠正"。
2. candidate.md：实现提交 38ab493／材料提交 cefbb6d＋本轮补证提交分层标注（已改）。
3. budget-ledger.md：补证阶段墙钟追加、状态版本、开审阻断项（P2 视裁定）入账。

## 6. 对象锁与提交（补证完成后执行并回填）

- 补证材料提交：`<SHA>`（证据 run 目录＋纠文；实现零改动由 `git diff 38ab493 -- <实现路径>` 为空证明）。
- 对象锁重生成＋verify：`<implementation_hash>` / `<full_candidate_hash>` / `<manifest_hash>`，STABLE。

## 7. 预算与开审条件

- 预算（沿用 420'）：前轮 ~160'；本轮补证至报告时 ~60-80'；累计约 220-240'，剩余约 180-200'。fix_batches 仍 1/1（补证不新增整改批次）。
- 开审条件：材料齐全；**P2（新模块变异/覆盖缺口）为开审阻断候选**，是否豁免/补齐由验收人裁定后，Planning 才执行 CODE_AUDIT_IN_PROGRESS 握手（当前 READY_FOR_CODE_AUDIT、NOT_STARTED，不变）。
