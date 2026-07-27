# TokenHub 项目调研

- 收集时间：2026-07-26 09:19 CST
- 结论修订时间：2026-07-26
- 调研对象：[astaxie/TokenHub](https://github.com/astaxie/TokenHub)
- 调研目的：确认 TokenHub 的产品定位、核心功能、技术特点、成熟度，以及它与仟流智算的关系。
- 调研方法：核对仓库 README、架构文档、三类角色指南、部署文档、Codex 接入文档、依赖文件、许可证、提交记录和 GitHub 仓库状态；最初与 v0.2 对照，结论现已写入《仟流智算产品需求文档 v0.3》《仟流智算技术需求文档 v0.3》。

## 一、结论

TokenHub 是一个面向企业内部的私有 AI Gateway 与治理控制台。它把 OpenAI、Azure OpenAI、Anthropic、Gemini、DeepSeek、Qwen、本地 vLLM/Ollama、OpenAI Codex 订阅账号等上游资源，统一包装成 OpenAI／Anthropic 兼容 API，再围绕团队、项目、API Key、模型权限、额度、并发、路由、成本和审计做集中管理。

TokenHub 与仟流智算不是“网关”和“非网关”的关系。企业 AI Gateway 是仟流智算的核心执行模块，没有 Gateway，资源、额度和规则只能停留在管理后台，无法对真实调用实施控制。

更准确的关系是：

- TokenHub 的主体能力与仟流智算的“企业 AI Gateway 模块”高度重叠。
- 仟流智算在企业 AI Gateway 之上，继续管理企业购买的 API 与 Coding Plan，并形成资源分配、额度规则、扣减、费用、异常和经营账本。

一句话判断：**仟流智算 = 企业 AI Gateway + 企业 AI 资源管理 + 额度与费用账本。**

因此，TokenHub 不只是一般参考项目，而是仟流智算 Gateway 模块的直接技术底座候选之一；但它仍不能直接替代 Coding Plan 和企业资源账本层。

## 二、TokenHub 具体做什么

它位于员工工具／企业应用与模型厂商之间：

```text
员工工具、Claude Code、Codex、企业应用
                  ↓
        TokenHub 统一模型 API
                  ↓
鉴权 → 模型权限 → 额度/并发 → 路由/故障转移 → 计量/审计
                  ↓
OpenAI / Azure / Anthropic / Gemini / DeepSeek / Qwen / 本地模型 / Codex 订阅
```

企业应用只需要使用 TokenHub 下发的项目 Key 和统一模型名，不需要直接持有每个厂商的真实凭证，也不需要了解上游模型名和账号。

## 三、主要功能

### 1. 统一模型 API

- OpenAI 兼容：`/v1/chat/completions`、`/v1/responses`、`/v1/responses/compact`、`/v1/embeddings`、`/v1/models`。
- Anthropic 兼容：`/v1/messages`、`/v1/messages/count_tokens`。
- 支持流式输出、工具调用、多模态图片、reasoning effort 等较新的协议字段。
- Claude Code、OpenAI Codex SDK／CLI、OpenAI SDK 等客户端可以通过修改 Base URL 接入。

### 2. 多厂商与多资源账号

- 支持 OpenAI／OpenAI-compatible、Azure OpenAI、Anthropic、Gemini、DeepSeek、Qwen、vLLM、Ollama、自定义上游。
- 将 Provider、Provider Resource、Provider Model 分层管理。
- 支持 OpenAI Codex 订阅账号的 OAuth、额度读取、Session Affinity 和 Compact 接口。

### 3. 模型目录

- 对下游暴露统一模型名。
- 维护模型能力、上下文窗口、输入／输出／缓存价格。
- 统一模型可映射到多个厂商模型。
- 只有存在健康可用路由的模型才应该暴露给用户。

### 4. 路由与高可用

- 按优先级、资源优先级、权重和故障转移顺序选路。
- 跳过停用或不健康的 Provider、Resource 和 Route。
- 非流式请求可以按候选顺序重试。
- 流式请求只允许在响应尚未真正输出前故障转移。
- 支持 Session Affinity；近期提交又加入了基于加权 Rendezvous Hash 的缓存亲和，目标是提高上游 Prompt Cache 命中率。

### 5. 项目、团队和 Key

- 围绕团队、项目、成员、成本中心组织使用边界。
- 用户和项目使用 TokenHub 下发的 Project API Key。
- Key 可以限制模型、额度、并发、有效期和 IP 白名单。
- Key 明文只显示一次，数据库只保留摘要及展示用前后缀。

### 6. 额度、并发和成本治理

- 请求前检查项目状态、Key 状态、过期时间、模型范围、IP、额度和并发。
- 用量和成本可归属到用户、项目、团队、模型和成本中心。
- 支持 Provider Resource 侧 RPM 等资源限制。
- 提供 Usage Analytics、Request Logs、Route Attempt Logs、Provider Observation 和 Audit Event。

### 7. 企业身份与权限

- 支持 OAuth／OIDC 企业登录。
- 内置钉钉、飞书和企业微信身份源模板。
- 产品界面分为普通用户、团队负责人、管理员三类工作区。
- 管理端文档还提出管理员、财务、安全、运维等 RBAC Scope。

### 8. 私有部署和运维

- 默认 SQLite 单实例，适合本地验证和单机私有部署。
- 支持 PostgreSQL 单实例。
- 支持远程 PostgreSQL + Nginx + 前后端多副本的水平扩展。
- 不依赖 Redis、消息队列和 Service Mesh，多实例协调数据直接放在 PostgreSQL。
- 提供 `/livez`、`/readyz`、`/healthz` 健康检查。
- 支持 Docker Compose 和安装脚本。

### 9. 国际化与控制台

- Next.js 管理控制台。
- 中、英、日三种语言。
- 支持浅色／深色模式、全局搜索和 API 文档视图。

## 四、技术架构和特点

| 层 | 实现 |
| --- | --- |
| 前端 | Next.js 16.2.9、React 19.2.7、TypeScript 6.0.3 |
| 后端 | Go 1.26、`net/http`、GORM |
| 数据库 | SQLite 默认；PostgreSQL 用于生产和多实例 |
| 部署 | Docker Compose；多实例模式带 Nginx |
| 许可证 | Apache License 2.0 |

后端把 Admin API、Model API、鉴权治理、路由、Provider Adapter、计量审计和持久化放在同一 Go 进程中；控制面和数据面是逻辑隔离，不是物理微服务。

几个值得注意的工程特点：

1. **网关协议做得比较深。** 不只是把 JSON 原样转发，还处理 Anthropic／Gemini 的工具调用、流式事件、图片块、Reasoning Signature 和协议错误。
2. **路由已经进入 Agent 负载细节。** Session Affinity、流式故障转移和 Prompt Cache Locality，说明它关注多轮 Agent 使用的缓存成本与稳定性。
3. **安全边界比较完整。** 上游凭证 AES-GCM 加密；项目 Key 保存 SHA-256 摘要；生产启动会拒绝弱 Secret 和占位密码。
4. **部署依赖较少。** SQLite 可快速启动，生产再迁 PostgreSQL；多实例不用 Redis，运维简单，但数据库承担更多协调职责。
5. **身份治理比一般中转站更企业化。** 团队、项目、成本中心、OAuth/OIDC、RBAC 和审计形成完整控制面。

## 五、和仟流智算的对照

| 维度 | TokenHub | 仟流智算 v0.3 |
| --- | --- | --- |
| 一句话定位 | 企业私有 AI Gateway | 企业 AI Gateway + 企业 AI 资源管理 + 额度与费用账本 |
| 核心对象 | 模型、Provider、Route、Project、Key | Gateway 调用 + 厂商资源 + 员工／项目 + 额度、规则和账本 |
| 使用边界 | 团队、项目、成本中心 | 单企业的员工、项目 |
| 上游范围 | 国际／国内 API、本地模型、Codex 订阅 | 首期 DeepSeek API、智谱 Coding Plan、Kimi Coding Plan |
| 下游协议 | OpenAI + Anthropic，兼容面较广 | 首期同样要求 OpenAI + Anthropic |
| 路由 | 优先级、权重、健康、故障转移、亲和 | 套餐优先、同池切换、API 兜底需显式开启 |
| 配额 | Key／Project 的配额、并发、RPM | 主体额度、厂商周期、超额许可、资源池额度 |
| 计量重点 | Token、估算成本和多维归属 | 原始用量、实际扣减额度、实际费用三分离 |
| 套餐语义 | 支持 Codex 订阅资源，但公开文档未形成通用 Coding Plan 规则体系 | Coding Plan 是首期主业务，包含扣减倍数、周期、套餐内费用和规则版本 |
| 内容隐私 | 架构允许记录 Request Payload Log，并提醒配置留存策略 | 明确不保存提示词、代码、文件和模型回答正文 |
| 身份权限 | 三类工作区 + OAuth/OIDC + RBAC | 一期只有同权管理员；员工不提供 Web 后台 |
| 部署 | Go 模块化单体；SQLite／PostgreSQL | 四平面逻辑架构；一期 Web、Control API、Gateway、Worker + PostgreSQL／Redis，Node／Go 由 POC-04 ADR 冻结 |

### Gateway 模块的直接重叠

- 企业内部统一 Gateway。
- 不把上游真实凭证交给员工。
- 下发独立 Key。
- 多上游资源池和故障转移。
- 模型授权、额度、并发和用量统计。
- OpenAI／Anthropic 兼容。
- 私有部署、请求日志和审计。

这些不是仟流智算的可选附加能力，而是 Gateway 模块必须交付的基础能力。TokenHub 在这一层与仟流智算构成直接重叠。

### 仟流智算在 Gateway 之上的业务层

1. **Coding Plan 不是一种 Provider，而是一种财务和额度制度。**
2. **原始用量、实际扣减、实际费用必须是三个可追溯数字。**
3. **每次扣减必须引用当时的规则版本，不能用新规则重算历史。**
4. **套餐优先、API 兜底默认关闭，避免企业出现意外费用。**
5. **员工／项目是企业资源分配主体，不只是一个 Project Key。**
6. **默认零内容留存，只保存完成计量和解释所需的元数据。**

### 修正后的仟流智算总体结构

```text
仟流智算
├── 管理控制面
│   ├── 厂商资源、员工、项目和 Key
│   ├── 模型授权、额度、规则和告警
│   └── 把管理策略下发给 Gateway
├── 企业 AI Gateway
│   ├── Key 鉴权和模型权限
│   ├── OpenAI／Anthropic 协议适配
│   ├── Provider／Resource／Route
│   ├── 健康、并发、限流、故障转移和 Session Affinity
│   └── 流式提交边界、取消和 usage 解析
├── 计量与账本
│   ├── ai_request
│   ├── upstream_attempt
│   ├── usage_event
│   └── ledger_entry
└── 运维与安全
    ├── 健康检查、审计、备份和告警
    └── Key／Secret 安全和正文零留存
```

Gateway 不是普通外围模块，而是把管理规则变成真实调用行为的数据面。管理控制面负责“决定”，Gateway 负责“执行”，计量账本负责“证明”。

### 技术底座候选的重新判断

| 候选 | 优势 | 关键缺口／风险 |
| --- | --- | --- |
| TokenHub | 企业 Gateway 模型完整；Provider／Resource／Route、Key 摘要、路由 Attempt、身份治理和私有部署较清晰；Apache 2.0 | 项目仍早期；Coding Plan 通用账本不足；需要验证智谱、Kimi 和四种客户端 |
| Sub2API | 订阅账号、协议转换、流式边界、Sticky Session、账号池和调度代码较深；本地已有大量代码 | 当前 Key 明文落库；没有仟流要求的逐 Attempt 业务账本；包含支付、营销和中转站业务包袱；`LICENSE` 为 LGPL v3，但 README 同时声明“无商业授权”，商业使用前必须单独确认许可边界 |
| 自研 Gateway | 领域和隐私边界最干净 | 协议、流式、故障转移和多厂商适配的开发与验证成本最高 |

现阶段不能把 TokenHub 只当作旁路参考，也不能因为已有 Sub2API 代码就默认底座已经确定。进入 Stage 02 前，应使用同一组真实请求对 TokenHub 和 Sub2API 做黑盒 PoC，再用协议兼容、Coding Plan 改造量、Key 安全、逐 Attempt 账本、零内容留存、许可和维护成本进行决策。

## 六、成熟度判断

截至采集时，GitHub 页面显示约 626 Stars、76 Forks、163 Commits、5 个 Pull Requests、0 个 Issues。最近一天仍有大量协议、路由、身份源和界面提交，项目活跃度很高。

但不能据此直接判断为生产成熟：

- 前端版本仍是 `0.3.0`。
- GitHub Releases 页面还没有正式 Release。
- README 明确写着公开镜像不可用时安装脚本会回退到本地构建。
- 功能扩张和修复速度很快，接口与数据模型仍可能变化。
- 仓库文档完整度较高，但仍需要真实压测、故障注入、数据迁移、账单准确性和安全审计验证。

因此，它目前更像一个**功能完整度快速上升、值得跟踪和验证的早期企业网关项目**，而不是拿来即用、无需验证的成熟基础设施。

## 七、对仟流智算的建议

### 可以直接借鉴

1. 把 TokenHub 作为 Gateway 模块的直接底座候选，而不只是功能清单参考。
2. Provider → Resource → Model Route 的分层。
3. 路由优先级、权重、健康、故障转移和 Session Affinity。
4. OpenAI／Anthropic 协议适配的测试矩阵。
5. 流式响应开始前可切换、开始后不可切换的故障边界。
6. 项目 Key 的一次展示、摘要存储、IP 白名单和并发租约。
7. Provider Probe、Route Attempt、Request ID 和审计事件。
8. SQLite 快速体验 + PostgreSQL 生产的部署分层思路。
9. 钉钉、飞书、企业微信身份源模板，可放到仟流智算二期。

### 不建议照搬

1. 不要把仟流智算止步于通用“模型聚合网关”；Gateway 是核心模块，但不是全部产品。
2. 不要用通用 Token 账单替代 Coding Plan 的实际扣减账本。
3. 不要默认保存 Request／Response Payload。
4. 不要一期就复制完整团队、成本中心、复杂 RBAC 和多语言，避免偏离 10 人内部试用目标。
5. 不要因为 TokenHub 支持很多 Provider，就扩大仟流一期上游范围。

### 建议的下一步验证

对 TokenHub 做一次短期 PoC，而不是立刻改技术路线：

1. 部署 PostgreSQL 单实例版本。
2. 接入 DeepSeek API、一个智谱／Kimi Coding Plan、Codex 或 Claude Code。
3. 验证普通请求、流式、工具调用、取消、429、账号失效、同池切换。
4. 检查它能否提供仟流需要的原始用量、扣减规则版本、套餐周期和实际费用数据。
5. 统计需要新增或改写的数据表、路由逻辑和管理页面。

PoC 后才能判断是“借鉴实现”“复用部分代码”，还是“基于 TokenHub 二次开发”。

## 八、信息来源

### TokenHub 一手资料

1. TokenHub README  
   https://github.com/astaxie/TokenHub/blob/main/README.md
2. TokenHub Architecture  
   https://github.com/astaxie/TokenHub/blob/main/docs/architecture.md
3. User Guide  
   https://github.com/astaxie/TokenHub/blob/main/docs/user-guide.md
4. Team Leader Guide  
   https://github.com/astaxie/TokenHub/blob/main/docs/team-leader-guide.md
5. Administrator Guide  
   https://github.com/astaxie/TokenHub/blob/main/docs/administrator-guide.md
6. Deployment Guide  
   https://github.com/astaxie/TokenHub/blob/main/docs/deployment.md
7. Codex TokenHub Profile Quick Start  
   https://github.com/astaxie/TokenHub/blob/main/docs/codex-tokenhub-profile-quick-start.md
8. Go dependencies  
   https://github.com/astaxie/TokenHub/blob/main/backend/go.mod
9. Frontend dependencies and version  
   https://github.com/astaxie/TokenHub/blob/main/frontend/package.json
10. Apache License 2.0  
    https://github.com/astaxie/TokenHub/blob/main/LICENSE
11. GitHub Releases  
    https://github.com/astaxie/TokenHub/releases
12. Commit history  
    https://github.com/astaxie/TokenHub/commits/main/
13. Cache-locality session affinity and streaming failover commit  
    https://github.com/astaxie/TokenHub/commit/0665027e8d83137f185b9f0c8ab355d8cf947597
14. Anthropic／Gemini tools and incremental streaming commit  
    https://github.com/astaxie/TokenHub/commit/6bbbfad0f262daab607aa62520920ad3f81f2f1f

### 仟流内部对照资料

1. `仟流智算-产品需求文档-v0.2.md`
2. `仟流智算-技术需求文档-v0.2.md`
3. `原型/README-原型v1.md`
