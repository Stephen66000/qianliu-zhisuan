# 仟流智算 Planning Change Log

| 项目 | 内容 |
| --- | --- |
| 产品版本 | v0.3 |
| Owner／批准人 | 佳哥 |
| 当前有效计划 | [详细开发计划与排期 v0.3.1](./仟流智算-详细开发计划与排期-v0.3.md) |
| 当前变更数 | 8 |

## 使用规则

只有目标、范围、依赖、安全、资源、验收、交付日历或关键合同发生实质变化时才登记。实现细节优化、文案修正和不影响合同的任务内调整不登记。

每条变更必须记录：

- `PC-ID`、日期、提出人；
- 变化事实与原因；
- 受影响的 PRD／TRD／里程碑／工作包；
- 风险和日历影响；
- 决策与批准人；
- 新基线版本；
- 未受影响范围是否可以继续。

## 变更记录

### PC-20260726-01：开发排期改为 AI 原生估算

| 项目 | 内容 |
| --- | --- |
| 日期 | 2026-07-26 |
| 提出／批准 | 佳哥 |
| 变化事实 | 原计划错误使用传统单人研发人日与逐里程碑缓冲，导致 AI 编程排到 2026-09-30 |
| 决策 | 以约 82 个 AI 实现、测试、集成与审核小时重新估算；P50 4 天出功能候选，P80 5 天出质量候选 |
| 外部门禁 | Windows 真机、真实 Provider 凭证、10 人入组、发布授权和完整自然月单列，不计入 AI 编程工期 |
| 影响范围 | 详细计划 §1～2、§5、§8～10；进度图、状态文件、Stage 02 评审档 |
| 不变项 | 产品范围、技术合同、安全、DoD、测试、Evidence 和 Review／Audit 强度 |
| 新计划版本 | v0.3.1 |

### PC-20260726-02：Stage 01 三方 SOP 审核整改

| 项目 | 内容 |
| --- | --- |
| 日期 | 2026-07-26 |
| 提出 | Claude（K5）三方 SOP 合规审核 |
| 批准／执行 | 佳哥授权开始整改；Planning 执行文档与治理项 |
| 变化事实 | Stage 01 内容基本达标，但独立评审、WT 三角色签字、六要素绑定、真实周期自包含、风险 Owner／退出条件和单一事实源未闭合 |
| 决策 | YAML 作为阶段级唯一事实源，HTML 由生成脚本同步；开发规划明确为 Stage 01 立项基线；Stage 02 预生成制品统一标记 `NOT_DUE` 候选 |
| POC-04 裁定 | 当前决策是不复用外部底座，因此不为落选路径追加同夹具全量压测；只有 ADR 复核并重新考虑直接复用时才补齐 |
| 影响范围 | PRD 空状态、TRD 人工接管／PoC 映射、立项基线、风险表、Stage 01 评审与进度图、状态 YAML、Stage 02 候选措辞、POC-02／04 Evidence |
| 不变项 | v0.3 产品目标、scope／non-scope、Gateway 主线、安全与零正文留存、Stage 02／03 未获授权 |
| WT 三角色签字 | 佳哥已于 2026-07-26 23:51（Asia/Shanghai）确认 WT-01～20 全部 PASS |
| 当时闸口 | 按当时口径，等待独立 Reviewer 直接签发 Stage 01 三态结论；后由 PC-20260727-03 按新 SOP §3.2.1 纠正 |
| 新候选版本 | v0.3.1；正式评审锁已生成 |

### PC-20260727-03：Owner 对 Stage 01 作最终放行决定

| 项目 | 内容 |
| --- | --- |
| 日期 | 2026-07-27 |
| 提出／批准 | 佳哥 |
| Owner 原始决定 | “Owner 已批准、独立性门禁被豁免” |
| 变化前 | 项目误认为审核 AI 必须进入主任务并直接签署项目评审档 |
| 变化后 | Stage 01 独立审核报告作为审核 Evidence；主 AI 完成整改；产品／业务／技术 Owner 作最终放行决定 |
| SOP 口径 | 符合 2026-07-27 修订后的主文件 §3.2.1“双 AI 审核与 Owner 放行”；审核建议与 Owner 决定分别保留 |
| 允许 | 进入 Stage 02 正式开发计划评审 |
| 不允许 | 直接进入 Stage 03、执行 W01、使用真实生产流量／扣费，或豁免后续 Review／Audit |
| POC-02 | Owner 接受 `OWNER_ATTESTED_LEGACY_RESULT` 作为进入计划的风险；真实上线回归仍是对应 Provider 的硬门禁 |
| 影响范围 | Stage 01 评审档、阶段状态、进度图、Owner 最终决定、Stage 02 评审候选和候选锁 |
| 恢复执行点 | Stage 02 开发执行就绪评审 |
| Evidence | [Stage 01 原始决定](./仟流智算-Stage01独立性门禁豁免决定-v0.3.2.md)、[按当前 SOP 形成的 Owner 最终放行决定](./仟流智算-Stage01-Owner最终放行决定-v0.3.3.md) |

### PC-20260727-04：Stage 02 独立审核问题整改

| 项目 | 内容 |
| --- | --- |
| 日期 | 2026-07-27 |
| 提出 | ZCode 独立审核报告 |
| 批准／执行 | 佳哥要求整改报告中的有效问题；Planning 执行 |
| 审核建议 | `NOT_READY` |
| 有效问题 | 进度图六组硬编码 DONE、DP-01 状态失真、M1～M6 HIGH 依据未逐项绑定、Stage 02 状态双写、Owner 决策要素未落档 |
| 不采纳为阻塞 | “82 小时没有拆解依据”；详细计划已有 D1～D5 和 W01～W27 逐项时间盒，本轮只补估算口径声明 |
| 决策 | 按新 SOP §3.2.1 保留 ZCode 报告作为独立审核 Evidence；主 AI 精准整改并形成 v0.3.3 候选；由 Owner 决定是否进入 Stage 03 |
| 不变项 | 产品目标、scope／non-scope、技术架构、29 个工作包、P50/P80 主排期、外部门禁和 Stage 03 审核强度 |
| Evidence | [Stage 02 SOP 合规审核报告](../仟流智算-Stage02-SOP合规审核报告-20260727.md) |

### PC-20260727-05：安全依赖升级（代码质量 Audit Q-DEP-1 整改）

| 项目 | 内容 |
| --- | --- |
| 日期 | 2026-07-27 |
| 提出 | ZCode 独立审核（代码质量 Audit round 1，Q-DEP-1 P2） |
| 批准／执行 | 佳哥授权整改；主 AI 执行 |
| 变化事实 | undici 7.16.0（GHSA-g8m3-5g58-fq7m，high）→ ≥7.28.0；fastify 5.6.1（body validation bypass，high）→ ≥5.7.2 |
| 风险 | fastify 升级涉及 breaking change 风险，须全工程 test 验证北向合同（OpenAI/Anthropic DTO）未破 |
| 影响范围 | apps/gateway、apps/control-api、packages/provider-adapters 的依赖版本；工程规则 §2 版本基线 |
| 不变项 | 产品目标、scope、技术架构、北向协议合同、29 个工作包 |
| 决策 | 安全漏洞为实质安全变化，按工程规则 §9 升级处理（不属"悄悄漂移"）；升级后全工程命令复测 + 北向合同回归（w05/w08/w09/w10 e2e） |
| Evidence | 待整改报告 + pnpm audit 清零 |

### PC-20260728-06：M5 W18 前端首次落地引入新依赖

| 项目 | 内容 |
| --- | --- |
| 日期 | 2026-07-28 |
| 提出／批准 | 佳哥（W18 前端交接文档 §4.2"已与佳哥确认"） |
| 变化事实 | apps/web 从 W01 占位骨架进入 W18 实际开发，引入前端框架依赖：react-router-dom 7.9.6（七入口路由）、@tanstack/react-query 5.90.20（服务端状态/三态）、lucide-react 0.469.0（功能图标，视觉规范 §9 指定 Lucide）、tailwindcss 3.4.17 + postcss 8.5.6 + autoprefixer 10.4.20（语义令牌样式方案，视觉规范 §13.2）、@testing-library/react 16.3.0 + @testing-library/jest-dom 6.9.1 + jsdom 26.1.0（组件单测）、eslint-plugin-react-hooks 5.2.0（hooks 规则补齐） |
| 原因 | 仟流视觉规范 §13.2 给出 Tailwind 语义令牌集成方案；交接文档 §4.2 明确引入清单；状态管理只用 TanStack Query + React 内置状态，不引入 Redux/Zustand（已确认） |
| 影响范围 | apps/web/package.json、pnpm-lock.yaml、eslint.config.mjs（注册 react-hooks）、apps/web test script 指向本包 vitest.config.ts（jsdom 环境 + .tsx include，根配置为 node 环境）；工程规则 §2 版本基线补充前端框架依赖 |
| 不变项 | React 19.1.1 / Vite 7.1.7 / TS 5.9.3 / Vitest 3.2.4 冻结版本不动；后端零改动；产品范围与 DoD 不变；前端只读消费后端、不重算账本（详细计划行 146） |
| 风险 | 无后端合同影响；Tailwind 3.4.17 选 v3 而非 v4 以保持与既有 PostCSS 生态稳定 |
| 决策 | 按交接文档执行，全部依赖精确锁版本；license 均为 MIT |
| Evidence | `V3/Evidence/M5/W18/` |

### PC-20260728-07：M5 W19 前端表单依赖与并发语义

| 项目 | 内容 |
| --- | --- |
| 日期 | 2026-07-28 |
| 提出／批准 | 佳哥（W18 handoff §8 W19 范围"前端补表单 + react-hook-form"） |
| 变化事实 | apps/web 新增 react-hook-form 7.55.0 + @hookform/resolvers 5.5.7（zod4 兼容）+ @testing-library/user-event 14.6.1（写操作交互单测）；后端无新依赖 |
| 并发语义决定 | 写操作并发修改采用 `updated_at` 乐观锁（前端携带读取快照的 updated_at，0 行命中 → 409 conflict），不引入 ETag/版本号新字段；凭证恢复为单次状态机迁移（WT-19），天然幂等 |
| 影响范围 | apps/web/package.json、pnpm-lock.yaml；后端新增 admin-write-repository + admin-writes/routes（更新/停用/凭证恢复 + 乐观锁 + audit） |
| 不变项 | 六要素其余五项不变；W18 已交付功能不受影响；凭证明文绝不入库/回显红线不变 |
| 决策 | react-hook-form 为一期表单唯一方案；@hookform/resolvers 必须 ≥5.x 以兼容项目 zod 4.1.11 |
| Evidence | `V3/Evidence/M5/W19/` |

### PC-20260728-08：M5 双审整改——并发乐观锁由 updated_at 改为单调 version

| 项目 | 内容 |
| --- | --- |
| 日期 | 2026-07-28 |
| 提出 | M5 双审 Reviewer（Codex 独立会话，P2-01） |
| 批准／执行 | 佳哥要求全部整改；主 AI 执行 |
| 变化事实 | PC-20260728-07 曾登记"写操作并发修改采用 `updated_at` 乐观锁，不引入 ETag/版本号新字段"。双审 P2-01 指出 `updated_at` 毫秒截断存在同毫秒 ABA 窗口（`date_trunc` 截断 + JS `new Date()` 同毫秒可不变），旧快照仍可能命中 WHERE，不是可靠版本号。整改引入单调递增 `version` 整数列（迁移 0017），前端 PATCH 改携带 `expected_version`（int），不再用 `expected_updated_at`。 |
| 影响范围 | `packages/database`（迁移 0017 新增 version 列）、`packages/database/src/repositories/admin-write-repository.ts`（version 乐观锁）、`apps/control-api/src/admin-writes/routes.ts`、`apps/web`（Principals/Grants 写操作改传 expected_version）、W19 并发冲突测试 |
| 不变项 | 六要素、凭证明文红线、前端只读消费后端、北向协议合同、29 个工作包、M5 DoD |
| 决策 | 采纳 Reviewer 整改意见，废弃 PC-07 的 `updated_at` 并发决定；version 为单调整数，避免时间戳精度问题；本变更推翻 PC-07 并发条款，故登记 |
| Evidence | `V3/Evidence/M5/M5-双审整改-Evidence-20260728.md` §2 P2-01 |
