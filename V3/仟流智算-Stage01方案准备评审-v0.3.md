# 仟流智算 Stage 01 产品与技术方案就绪评审候选

| 项目 | 内容 |
| --- | --- |
| 评审对象 | 仟流智算 v0.3 |
| 评审时间 | 2026-07-26 |
| 依据 | 《仟流 AI 开发 SOP v1.0》Stage 01 |
| 产品负责人 | 佳哥 |
| 技术负责人 | 佳哥 |
| 三方 SOP 合规审核员 | Claude（K5） |
| 三方 SOP 合规结论 | `NOT_READY`——内容基本达标，治理闸口未闭合 |
| 独立审核 AI | Claude（K5）；审核报告独立于主 AI 作者链 |
| Reviewer 建议 | `NOT_READY`——整改前内容基本达标，治理闸口未闭合 |
| 当前性质 | 独立审核报告＋主 AI 整改＋Owner 最终放行 |
| Owner 决定 | `OWNER_APPROVED` |
| SOP 合规标记 | `COMPLIANT_WITH_SOP_3.2.1` |

> Claude 已针对 Stage 01 候选输出独立审核报告，主 AI 按问题完成整改，佳哥完成 WT 三角色签字并最终决定放行。按现行 SOP §3.2.1，审核 AI 不需要进入主任务或直接修改本评审档；审核建议与 Owner 决定分别保留。

正式评审输入：

- [Stage 01 独立评审任务书](./仟流智算-Stage01独立评审任务书-v0.3.md)
- [三方审核前候选锁（已失效）](./仟流智算-Stage01评审候选锁-v0.3.pre-remediation.sha256)
- [整改校验锁（签字前，已失效）](./仟流智算-Stage01整改校验锁-v0.3.1.pre-signoff.sha256)
- [Owner 豁免前候选锁 v0.3.1](./仟流智算-Stage01评审候选锁-v0.3.1.pre-waiver.sha256)
- [Owner 原始决定](./仟流智算-Stage01独立性门禁豁免决定-v0.3.2.md)
- [按当前 SOP 形成的 Owner 最终放行决定](./仟流智算-Stage01-Owner最终放行决定-v0.3.3.md)
- [Stage 01 Owner 封板锁 v0.3.3](./仟流智算-Stage01封板锁-v0.3.3.owner-approved.sha256)
- [三方 SOP 合规审核报告](../仟流智算-Stage01-SOP合规审核报告-20260726.md)
- [审核依据与来源](./仟流智算-Stage01审核依据与来源-v0.3.1.md)

## 0. 三方审核整改状态

| 审核项 | 等级 | Owner | 截止条件 | 当前状态 | Evidence |
| --- | --- | --- | --- | --- | --- |
| 审核 AI 未进入主任务签署评审档 | P0（旧口径） | 佳哥 | 按 SOP §3.2.1 明确审核链与最终决策权 | `resolved`；外部报告即审核 Evidence，Owner 最终决定已落档 | [独立审核报告](../仟流智算-Stage01-SOP合规审核报告-20260726.md)、[Owner 决定](./仟流智算-Stage01-Owner最终放行决定-v0.3.3.md) |
| WT-01～20 三角色共同走查签字 | P1 | 佳哥 | 20 项逐项复核并按产品／业务／技术三角色实名签字或记录差异 | `resolved` | [WT 签字走查](../原型/V3/仟流智算-WT01-WT20逐项签字走查-v0.3.md) |
| 评审结论六要素绑定 | P1 | Planning | 新候选冻结前 | `resolved` | 本文 §5.1 |
| 真实业务周期基线自包含 | P1 | Planning | 新候选冻结前 | `resolved` | [立项与版本基线 §3.1](./仟流智算-开发规划-v0.3.md#31-立项与真实业务周期基线) |
| 风险补 Owner 与退出条件 | P1 | Planning | 新候选冻结前 | `resolved` | [立项与版本基线 §8](./仟流智算-开发规划-v0.3.md#8-风险) |
| 单一权威与 plan Evidence | P1 | Planning | YAML 与进度图验证一致 | `resolved` | [阶段状态基线](./仟流智算-stage-state-v0.3.yaml)、[进度图](./仟流智算-Stage01方案准备进度图-v0.3.html) |
| STAGE_DATA.meta 三字段 | P1 | Planning | 进度图脚本校验通过 | `resolved` | [进度图](./仟流智算-Stage01方案准备进度图-v0.3.html) |
| 统一日常更新入口 | P1 | Planning | YAML、工程规则、进度图声明一致 | `resolved` | [项目工程规则 §8](./仟流智算-项目工程规则-v0.3.md#8-evidence-与-handoff) |
| Stage 02 预生成制品措辞 | P1 | Planning | 全文不再称未授权制品为权威成果 | `resolved` | [立项与版本基线 §9](./仟流智算-开发规划-v0.3.md#9-stage-02-候选制品) |

P2 文档结构项已收敛；POC-02 仍保留一个不能靠改文档消除的证据等级边界：

| 项目 | 状态 | Reviewer 必须判断 |
| --- | --- | --- |
| POC-02 既有三类上游结论 | `OWNER_ATTESTED_LEGACY_RESULT`；旧原始 Evidence 丢失、不可复跑 | Owner 已接受其作为进入 Stage 02 的风险；不得升级为原始 PoC，真实上线回归仍阻塞对应 Provider |

## 1. 已完成

本节记录截至 2026-07-26 的实际制品和执行 Evidence。产品架构图、Stage 01 方案准备进度图、V4 原型、WT-01～20、POC-01～04、Gateway 底座 ADR、来源清单、隔离 HTTP Gateway、PostgreSQL、Redis、日志和 Trace 闭环均已完成。

| 检查项 | 状态 | Evidence |
| --- | --- | --- |
| 产品目标、用户和真实问题 | `done` | [PRD v0.3 §1～5](./仟流智算-产品需求文档-v0.3.md#1-一句话定位) |
| Token 基础单位与企业团队目标边界 | `done` | [PRD v0.3 产品最高原则、§1、§4](./仟流智算-产品需求文档-v0.3.md)、[TRD v0.3 §1～2](./仟流智算-技术需求文档-v0.3.md#1-技术目标) |
| 四个核心性质与闭环要求 | `done` | [PRD v0.3 产品最高原则](./仟流智算-产品需求文档-v0.3.md)、[TRD v0.3 §1.1](./仟流智算-技术需求文档-v0.3.md#11-四个核心性质的技术闭环) |
| 一期 scope / non-scope | `done` | [PRD v0.3 §4](./仟流智算-产品需求文档-v0.3.md#4-阶段边界) |
| 端到端业务流程 | `done` | [PRD v0.3 §6～9](./仟流智算-产品需求文档-v0.3.md#6-核心业务流程) |
| 产品架构与业务闭环图 | `done` | [产品架构图 v0.3](./仟流智算-产品架构图-v0.3.html) |
| 首页、菜单和异常口径 | `done` | [PRD v0.3 §10～11](./仟流智算-产品需求文档-v0.3.md#10-管理后台) |
| 员工／项目统一主体 | `done` | [PRD v0.3 §5](./仟流智算-产品需求文档-v0.3.md#5-用户和使用主体)、[TRD v0.3 §5](./仟流智算-技术需求文档-v0.3.md#5-核心领域模型) |
| 四种员工工具范围 | `done` | [PRD v0.3 §12](./仟流智算-产品需求文档-v0.3.md#12-客户端与环境) |
| DeepSeek、智谱、Kimi 范围 | `done` | [PRD v0.3 §7～9](./仟流智算-产品需求文档-v0.3.md#7-厂商资源) |
| Gateway 核心定位与四平面 | `done` | [PRD v0.3 §1、§4](./仟流智算-产品需求文档-v0.3.md#1-一句话定位)、[TRD v0.3 §3](./仟流智算-技术需求文档-v0.3.md#3-总体架构) |
| Provider／Resource／Route 与协议能力 | `done` | [TRD v0.3 §5～7](./仟流智算-技术需求文档-v0.3.md#5-核心领域模型) |
| 健康路由、Affinity 和流式边界 | `done` | [TRD v0.3 §8～9](./仟流智算-技术需求文档-v0.3.md#8-gateway-请求流程) |
| 账号池生命周期、多因子调度、目标协议矩阵和 WebSocket 边界 | `done` | [PRD v0.3 §4.1](./仟流智算-产品需求文档-v0.3.md#41-一期范围)、[TRD v0.3 §5～9](./仟流智算-技术需求文档-v0.3.md#5-核心领域模型) |
| 持续供给预测与峰谷经营调度 | `done` | [PRD v0.3 §7.5](./仟流智算-产品需求文档-v0.3.md#75-持续供给与经营调度)、[TRD v0.3 §9.1～9.2](./仟流智算-技术需求文档-v0.3.md#91-经营调度叠加) |
| 逐 Attempt 消耗与分层账本 | `done` | [PRD v0.3 §9](./仟流智算-产品需求文档-v0.3.md#9-用量扣减和费用)、[TRD v0.3 §5.7](./仟流智算-技术需求文档-v0.3.md#57-请求和账本) |
| API 价格与套餐扣减边界 | `done` | [PRD v0.3 §9](./仟流智算-产品需求文档-v0.3.md#9-用量扣减和费用)、[TRD v0.3 §10](./仟流智算-技术需求文档-v0.3.md#10-额度和费用计算) |
| Key 安全、来源治理、当前正文零留存和未来受控留存边界 | `done` | [PRD v0.3 §13](./仟流智算-产品需求文档-v0.3.md#13-安全和隐私)、[TRD v0.3 §14](./仟流智算-技术需求文档-v0.3.md#14-登录和安全) |
| 真实业务周期 | `done` | [PRD v0.3 §15](./仟流智算-产品需求文档-v0.3.md#15-真实业务周期) |
| 初始验收矩阵 | `done` | [PRD v0.3 §14～16](./仟流智算-产品需求文档-v0.3.md#14-功能需求)、[开发规划 v0.3 §7](./仟流智算-开发规划-v0.3.md#7-初始测试矩阵) |
| 必要 PoC 与底座对照设计 | `done` | [TRD v0.3 §17](./仟流智算-技术需求文档-v0.3.md#17-poc) |
| V4 Gateway 原型增量 | `done` | [V4 原型](../原型/V3/仟流智算-原型-v4.html)、[原型审核总结](../原型/V3/仟流智算-0.3原型审核总结.md) |
| WT-01～WT-20 逐项走查 | `done` | [逐项签字走查](../原型/V3/仟流智算-WT01-WT20逐项签字走查-v0.3.md) |
| Gateway 一期主实现路径 | `done` | [ADR-GATEWAY-BASELINE](./ADR-GATEWAY-BASELINE.md) |
| 第三方源码来源治理 | `done` | [第三方源码来源与许可证清单](./第三方源码来源与许可证清单-v0.3.md) |
| Stage 01 方案准备进度图 | `done` | [39 项项目进度控制台](./仟流智算-Stage01方案准备进度图-v0.3.html) |

## 2. P1 阻塞项与本轮状态

### P1-01：v0.3 Gateway 原型增量

- Owner：佳哥委托 K3。
- 当前状态：`resolved`。
- Evidence：[V4 原型](../原型/V3/仟流智算-原型-v4.html) 已覆盖 Model Route、凭证状态、评分、健康／冷却、供给预测、经营调度、逐 Attempt 账本和能力错误契约。
- 修正：双 Attempt 聚合、计量质量枚举、按模型评分和调度节省提示均已复验。

### P1-02：WT-01～WT-20 真实任务走查

- Owner：佳哥。
- 当前状态：`resolved`。
- Evidence：[WT-01～WT-20 逐项签字走查](../原型/V3/仟流智算-WT01-WT20逐项签字走查-v0.3.md)，原型产品口径 20／20 PASS。
- 签字边界：佳哥已于 2026-07-26 23:51（Asia/Shanghai）按产品负责人、业务代表和技术负责人三角色逐项确认 WT-01～20 全部 PASS；Codex 作者侧记录不替代该签字。

### P1-03：客户端、上游与持久化 PoC

- Owner：佳哥。
- 当前状态：`resolved`。
- POC-01：`PASS_FOR_STAGE01`。隔离 Gateway 已用真实 HTTP 进程验证 Models、OpenAI Chat、Anthropic Messages、Bearer Key、request ID 和显式能力错误；Windows GUI E2E 移至 M6/M7。Evidence：[POC-01](./PoC/POC-01-北向客户端兼容-Evidence.md)。
- POC-02：Owner 当前判定为 `ACCEPTED_FOR_STAGE01`，证据等级为 `OWNER_ATTESTED_LEGACY_RESULT`。旧原始 Evidence 丢失、不可复跑；本轮只补齐 DeepSeek／智谱／Kimi 环境变量安全注入、强制脱敏与 `.env` 隔离。正式 Reviewer 必须独立判断是否接受该证据等级。Evidence：[POC-02](./PoC/POC-02-三类上游-Evidence.md)、[继承记录](./PoC/POC-02-既有结论继承记录-v0.3.md)。
- POC-03：`PASS`。12／12 持久化集成测试、18／18 核心回归、100 并发候选测试通过；PostgreSQL、Redis、JSONL 日志、OpenTelemetry Trace 与正文／Key／Session canary 已闭环。Evidence：[POC-03](./PoC/POC-03-计量闭环-Evidence.md)。
- 范围边界：Windows 真机只阻塞对应客户端交付签字；真实三厂商回归只阻塞对应 Provider 上线，不阻塞 Gateway、数据库、Web、账本和其他 Adapter 开发。

### P1-04：Gateway 底座 ADR 和源码来源清单

- Owner：技术负责人。
- 当前状态：`resolved`。
- 决策：一期只保留仟流独立 Node.js／TypeScript Gateway，不直接复用 TokenHub／Sub2API 源码。
- Evidence：[POC-04](./PoC/POC-04-Gateway基线对照-Evidence.md)、[ADR-GATEWAY-BASELINE](./ADR-GATEWAY-BASELINE.md)、[来源／许可证清单](./第三方源码来源与许可证清单-v0.3.md)。
- 来源边界：TokenHub 冻结 Commit；Sub2API 因本地快照缺 Git Commit，只允许隔离测试和设计对照。

## 3. 非阻塞待办

| 待办 | 等级 | Owner | 截止条件 | 复查触发点 |
| --- | --- | --- | --- | --- |
| 正式 Web 和 Gateway 域名 | P2 | 佳哥 | 部署设计冻结前 | 进入部署工作包 |
| 精确服务器规格 | P2 | 佳哥 | 容量／部署设计冻结前 | 质量候选形成 |
| 精确依赖版本 | P2 | 技术 Owner | W01 退出前 | 依赖解析、安全或 Node 兼容失败 |
| 数据保留期 | P2 | 佳哥 | 数据库正式迁移冻结前 | 企业合规要求变化 |
| Responses／Embeddings／count_tokens 一期取舍 | P2 | 佳哥 | 对应客户端／Adapter 工作包开始前 | 客户端真实需求或上游能力变化 |
| Responses WebSocket 一期取舍 | P2 | 佳哥 | 对应客户端工作包开始前 | 出现必须依赖 WebSocket 的真实客户端 |
| TokenHub／Sub2API 同夹具 100 并发对照 | P2 | 技术 Owner | 仅 ADR 复核触发后执行 | 主路径出现容量／维护性阻断 |
| 企业团队、成本中心、RBAC 和身份源产品化顺序 | P2 | 佳哥 | 内部自然月验收后进入 M9 前 | 试点结论或首个企业客户合同变化 |
| 未来受控正文留存能力 | `NOT_DUE` | 佳哥 | 明确企业需求且独立安全评审通过后另行立项 | 企业提出正文审计／质检需求 |
| 仟流智算 Agent 功能设计 | `NOT_DUE` | 佳哥 | 二期立项时 | 二期 Goal 获批 |
| 仟流 IDE Windows 适配 | 非本项目一期完成条件 | 佳哥 | 由仟流 IDE 独立阶段处理 | 第一方 Windows 客户端纳入交付 |
| 详细开发排期与工作包日历 | `WAITING_OWNER_DECISION` | Stage 02 Planning／佳哥 | Owner 最终决定放行后转正 | 佳哥核对 ZCode 报告、整改和 v0.3.3 候选 |

## 4. 一致性结论

[PRD v0.3](./仟流智算-产品需求文档-v0.3.md)、[TRD v0.3](./仟流智算-技术需求文档-v0.3.md)和[开发规划 v0.3](./仟流智算-开发规划-v0.3.md)当前在以下口径上一致：

- 企业 AI Gateway 是仟流智算一期核心执行模块；
- Token 是 API、Coding Plan 和账号池资源的统一基础用量事实，算力权益是上层产品表达；
- 仟流最终服务企业客户及其团队，内部单企业只是首期 Pilot；
- 持续生产、按量消耗、峰谷差异、计量和调度是产品与技术最高约束；
- 四个核心性质都必须形成输入、判断、动作、落账、查询和修正闭环；
- 控制平面、Gateway 数据平面、计量账本平面和运行安全平面职责分开；
- Provider、Provider Resource、Unified Model、Model Route 分层；
- Models、OpenAI Chat、Anthropic Messages 是一期最低 P0；Responses、Embeddings、count_tokens、SSE／WebSocket 已进入目标协议契约，启用顺序由 PoC 冻结；
- 能力不支持时显式拒绝，不静默删字段；
- 账号池覆盖 API Key、OAuth 和套餐会话的刷新、隔离与恢复；
- 路由按优先级、权重、健康、负载、错误率、TTFT、额度余量、重置时间、成本、并发和 Session Affinity 执行；
- SSE／WebSocket 首个有效输出后禁止切换或拼接第二个上游；
- 一个请求只有一个结算汇总，每个真实消耗 Attempt 保留不可覆盖的 usage 和账本明细；
- 健康路由解决技术可用性，峰谷、成本、额度和剩余周期共同形成经营调度；
- 供给预测展示消耗速度、预计耗尽、下一恢复、覆盖时长和可信度；
- 只有具备已发布反事实基线且实际执行的动作才计算调度节省；
- 下游 Key 摘要保存并可限制模型、IP、有效期、额度和并发；
- TokenHub／Sub2API 是工程学习样本，其企业治理、账号池、凭证生命周期、多因子调度、多协议和流式传输优势已进入仟流目标架构；仟流 PRD、Token 账本、领域模型和验收标准保持自有；
- 一期管理员使用桌面 Web；
- 一期员工使用仟流 IDE、WorkBuddy、Claude Code、ZCode；
- 仟流智算 Agent 属于二期，一期只预留入口位置；
- 使用主体只有员工和项目两类；
- 项目与员工复用相同 Key、模型、额度和账本；
- DeepSeek 为 API，智谱和 Kimi 为 Coding Plan；
- API 计算真实费用，套餐计算额度扣减；
- 额度有效期跟随厂商资源；
- 额度用完默认停止；
- 套餐优先、API 兜底默认关闭；
- 管理操作直接执行并保留操作日志；
- 一期没有手机端、语音和外部通知；
- 调用正文当前默认不保存；未来只有明确企业需求并完成独立安全评审后才允许受控启用。

当前未发现新的产品—技术阻断性冲突。

## 5. Owner 封板结论与独立评审边界

Reviewer 建议：`NOT_READY`（整改前）；Owner 最终决定：`OWNER_APPROVED`。

Stage 01 已按“双 AI 审核＋Owner 放行”完成：三方审核报告、主 AI 整改、WT-01～20 三角色签字、Gateway ADR、来源清单和四个 PoC Evidence 已形成，Owner 允许进入 Stage 02。

### 5.1 正式结论必须绑定的六要素

| 要素 | 当前绑定 |
| --- | --- |
| 项目和版本 | 仟流智算 v0.3 |
| 三份权威成果 | 产品方案：[PRD v0.3](./仟流智算-产品需求文档-v0.3.md)；技术方案：[TRD v0.3](./仟流智算-技术需求文档-v0.3.md)；立项与版本基线：[开发规划 v0.3](./仟流智算-开发规划-v0.3.md) |
| 允许动作 | 执行 Stage 02 开发执行就绪评审；按其问题返回 Planning 精准修正 |
| 禁止动作 | Stage 02 Owner 最终决定放行前，不得进入 Stage 03、执行 W01 或启动产品业务编码 |
| 待办、Owner、截止条件 | 佳哥核对 Stage 02 独立审核报告和整改候选并签发最终决定；Stage 03 启动前完成 |
| 复查触发点 | Stage 01 封板锁失效；Stage 02 发现 Stage 01 阻断性 Evidence Gap；目标、范围、安全、关键依赖、验收或真实业务周期发生实质变化 |

若未来恢复 Stage 01 独立评审，Reviewer 仍必须检查上述六要素，并对当时重新锁定的候选签发三态结论。

### 当前允许动作

- 验证 Stage 01 v0.3.3 Owner 封板锁；
- 验证 Stage 02 v0.3.3 整改候选锁；
- 由佳哥核对 Stage 02 独立审核报告和整改结果并作最终决定。

### 当前禁止动作

- 把 Reviewer 建议和 Owner 最终决定混写成一个结论；
- Stage 02 Owner 最终决定放行前进入 Stage 03；
- 启动产品业务编码、接入生产流量或真实扣费；
- 把 TokenHub／Sub2API 代码直接合入产品分支；
- 把 POC 密钥、`.env`、请求正文写入仓库、数据库、Redis、日志或 Trace。

## 6. 唯一下一步

佳哥核对 ZCode Stage 02 审核报告、本轮整改和 v0.3.3 候选锁。只有 Owner 决定为 `OWNER_APPROVED`，或 `OWNER_APPROVED_WITH_ACTIONS` 明确授权 Stage 03，才能执行 W01 或任何产品业务编码。
