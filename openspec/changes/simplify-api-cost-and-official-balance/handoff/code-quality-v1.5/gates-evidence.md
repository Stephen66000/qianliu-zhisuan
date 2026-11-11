# 门禁证据清单（v1.5 模板逐门禁；工具版本＝实际执行记录）

执行环境：Node v22.23.4＋corepack pnpm@11.11.0；执行人标注【子】＝glm-flash／【总】＝总指挥亲跑。

| # | 门禁 | 范围 | 命令 | 阈值/基线 | 结果 | 差异/待决 | 证据 |
|---|---|---|---|---|---|---|---|
| 1 | 类型检查 | 7 包 | `--filter <pkg> run typecheck` | 0 错误 | PASS【总：control-api/web/database；子：7 包各批】 | — | 各批回报＋本清单 |
| 2 | lint | 7 包 | `run lint --max-warnings=0` | 0 | PASS【同上】 | — | 同上 |
| 3 | 架构（运行时循环） | 695 生产文件 | `node scripts/check-architecture.mjs` | 无环 | **PASS（exit 0）【总】** | 仅证无运行时循环，非分层人工审 | 本文件记录 |
| 4 | 源码体量 | 全仓 | `node scripts/check-source-size.mjs` | ≤400/例外基线 | **PASS（exit 0，695 文件）【总】**（预检 10 项失败→GATE-01 三批拆分清零） | — | 三批回报＋提交 dbcecd8/17650a6/38ab493 |
| 5 | CQ-01 参数防护（定向） | rollback-delta 脚本 | docker 命令桩 20 用例 | 负向 exit≠0 零容器调用 | PASS【子跑 20/20；总独立桩抽查缺 live→exit2 零调用】 | 拒绝码 5→3 变化已记录，无外部依赖 | CODE-QUALITY-V15-20261107/red-evidence/ |
| 6 | X07 回归 | 主路线＋down 链 | 两个 integration 套件 | 11＋7 | **PASS【总亲跑 11/11＋7/7 @38ab493】** | — | 同上 logs/ |
| 7 | 单测/定向回归 | GATE-01 受影响域 | 各批 vitest 定向 | 全绿 | PASS【子：control-api 125 单测＋47＋11 集成；web 773/773×2＋13/13；database 239 单测＋~141 集成】 | web 全量首跑 1 次偶发失败未复现（已记录） | 三批回报 |
| 8 | 覆盖率＋ratchet | V3 各池 | `quality:coverage:*`＋`ratchet` | V3 §coverage | **部分**：domain/changed/pool030/040/043 exit 0 报告齐；**pool029 FAIL（w05 6 例，配置上下文型）→ratchet exit 1（仅缺 pool029 两报告）**；新模块不在任何池扫描面（覆盖不足见 P2） | P1 阻断（详见 gate-supplement-report）；本轮未修 | gate-supplement-run1/ |
| 9 | 变异（增量） | 本阶段高风险逻辑 | 既有 stryker 配置适用性核查 | V3 §mutation | **OPEN（无适用配置）**：pool039/043/021-r2 文件清单不含新模块与拆分产物（grep 实证）；本轮按指令不新增配置 | P2：最小方案＝两域增量 stryker 配置＋changed 清单纳入（授权项）；bash 脚本以既有 20 桩断言提请等价认定 | gate-supplement-report §3/§4 |
| 10 | 复杂度/认知复杂度/CRAP | eslint complexity＋覆盖率阀 | eslint（V3 §complexity） | 默认 30＋文件例外 | 间接 PASS（lint 0 含 complexity 规则）；**专项报告 NOT_RUN** | RequestDrilldown 主函数 73→50 仍靠例外＋disable（存量，GATE-01 批 2 已记录）；jshom/eslint-plato 类认知复杂度工具未配置 | — |
| 11 | 重复率 | apps+packages | `quality:duplication`（jscpd 5.0.14，既有） | ≤5% | **PASS（exit 0）**：克隆 0.49-0.62%，26 处 | 前轮"缺工具"系未查脚本清单的误记，本轮纠正并补跑 | gate-supplement-run1/jscpd.log |
| 12 | build/package | 受影响三包 | `--filter <pkg> run build` | 成功 | **PASS（exit 0×3）**：web vite 产物新鲜（含拆分模块）；control-api tsc 产出拆分 js；database 脚本为 noEmit 型（项目定义，如实记录） | — | gate-supplement-run1/batch-a.log |
| 13 | 依赖漏洞/许可证 | 全仓 prod | `audit:prod`＋`quality:licenses`（既有） | moderate/许可清单 | **双 PASS（exit 0）**：No known vulnerabilities；license gate passed | 前轮"未配置"误记，纠正 | gate-supplement-run1/audit.log＋licenses.log |
| 14 | 运行时一致性 | — | node -v 回显 | 22.23.4 | PASS（本轮全部命令） | — | 各命令记录 |

**待决项汇总**（不记 PASS、不记 N/A）：#8 覆盖率池复跑、#9 增量变异＋bash 脚本变异工具缺口、#10 认知复杂度工具、#11 重复率工具、#12 build、#13 安全/许可证工具。均属"缺工具/未执行"如实登记，最小落地建议如上；是否要求开审前补齐由 Planning/验收人裁定（变更须显式提出）。
