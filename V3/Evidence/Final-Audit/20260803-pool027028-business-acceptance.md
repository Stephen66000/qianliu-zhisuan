# POOL-027／POOL-028 生产业务验收证据

- 验收时间：2026-08-03（Asia/Shanghai）
- 生产入口：`https://ic.qianliuai.com`
- 生产发布目录：`/Users/stephen/releases/qianliu-zhisuan-pool027-a49ca355-20260803`
- 数据库最新迁移：`0037_client_identity`
- 验收方式：真实厂商资源、真实桌面客户端、生产 Gateway 与生产账本交叉核对
- 安全边界：未输出或保存 Key／厂商凭证明文；未重置 Key；已按授权发布并追加模型发现
  快照；未推送或创建 PR

## 结论

| 问题 | 结果 | 结论 |
| --- | --- | --- |
| POOL-027 | 通过／关闭 | DeepSeek 真实发现和受控接入通过；Kimi Coding Plan 与智谱 DEGRADED 资源已在修复版本完成生产同步，模型集合、来源版本及资源状态均正确。 |
| POOL-028 | 部分通过 | WorkBuddy、Codex、Z Code 三个真实客户端均被正确识别并落账，Agent 筛选可用；于滔实际只使用 WorkBuddy，当前仅待他使用自己的主体 Key 完成一次 WorkBuddy 最终验收。 |

## POOL-027 真实厂商验收

### DeepSeek：通过

- 真实调用 DeepSeek List Models 成功。
- 快照 ID：`debf474b-539b-4cec-968c-2a3c42fb2b3b`。
- 来源：`PROVIDER_API`；来源版本：`deepseek-list-models-v1`。
- 发现模型：`deepseek-v4-flash`、`deepseek-v4-pro`。
- 管理员确认后创建：
  - `qianliu-deepseek-deepseek-v4-flash`，`PENDING_CONFIG`，路由默认禁用；
  - `qianliu-deepseek-deepseek-v4-pro`，`PENDING_CONFIG`，路由默认禁用。
- 已有 `qianliu-deepseek / deepseek-chat` 路由保持启用，未被覆盖。
- 新模型没有自动扩展员工 Key 权限；于滔当前 ACTIVE Key 的授权模型数仍为 `2`。

### Kimi Coding Plan：原验收未通过，修复后生产复验通过

- 资源模式：`CODING_PLAN`；资源状态：`ACTIVE`。
- 该凭证仍在生产真实推理请求中正常使用，因此不是简单的失效凭证。
- 点击“同步模型”后，Moonshot 普通 List Models 返回 `401/UNAUTHORIZED`。
- 失败快照 ID：`2c21d761-2111-4939-8175-60520d0f30c7`。
- 来源版本：`kimi-list-models-v1`；模型条目数：`0`。
- 根因证据：`packages/provider-adapters/src/model-discovery.ts` 对 Kimi 不区分 `API` 与
  `CODING_PLAN`，统一调用 `https://api.moonshot.cn/v1/models`。Coding Plan 凭证可用于
  套餐推理，但不能被当作普通 API Key 执行该发现请求。

### 智谱 Coding Plan：原验收未通过，修复后生产复验通过

- 资源存在、加密凭证存在，模式为 `CODING_PLAN`，当前运行状态为 `DEGRADED`。
- 点击“同步模型”返回“资源不存在或没有可用凭证”，没有形成发现快照。
- 根因证据：`getResourceForModelDiscovery` 只读取 `ACTIVE` 资源；同步路由在调用智谱
  `VERSIONED_CATALOG` 前即返回 404。版本化目录本身不依赖厂商联网凭证，不应被
  `DEGRADED` 状态提前阻断。

### POOL-027 后续修复要求

1. Kimi `CODING_PLAN` 改用经厂商规则确认的套餐模型目录／套餐能力探测，不再复用普通
   API List Models；API 模式继续使用官方动态列表。
2. 智谱版本化目录允许已有、可管理的降级资源执行同步；只有需要真实联网调用时才按
   凭证状态分类阻断。
3. 补充 Kimi API／Coding Plan 分流、智谱 ACTIVE／DEGRADED 目录同步及生产回归测试，
   再使用真实凭证复验。

### 后续代码修复与本地复核

- Kimi 发现策略按资源模式分流：`API` 继续使用
  `https://api.moonshot.cn/v1/models`；`CODING_PLAN` 不再调用开放平台，改用
  `kimi-coding-plan-2026-08-03` 版本化官方目录。
- Coding Plan 目录包含 `k3`、`k3-256k`、`kimi-for-coding`、
  `kimi-for-coding-highspeed`；来源明确标记为 `VERSIONED_CATALOG`，不冒充当前凭证的
  实时授权结果。官方依据及 2026-08-03 19:40 收集时间见
  `_knowledge_base/厂商API模型自动发现与后台选择-2026年8月.md`。
- 资源模型发现、失败快照和确认接入均允许 `ACTIVE / DEGRADED`；其他不可服务状态仍被
  门禁，模型同步不会修改资源健康状态。
- 验证：Provider Adapter `78/78`、Database `28/28`、Control API `105/105`、
  POOL-027 定向接口集成 `5/5`；三个相关包 TypeScript 与 ESLint 全部通过。
- 上述内容是发布前记录；最终发布与生产复验结果见下节。

### 最终 v1.4 审计、发布与生产复验

- 审计等级：R3／I2；独立 Kimi Reviewer `PASS`，P0=0、P1=0、阻断性 Evidence Gap=0。
- 相对上一生产 release 的完整 checksum dry-run 只发现 5 个 POOL-027 实现／测试文件
  有效差异；`.DS_Store`、tsbuildinfo、Playwright 报告和部署 Manifest 等本机／生成项未进入
  候选。候选锁 manifest SHA-256：
  `a49ca355cd567ae0bb83b571c99730c519db607c4fbe09afe67d7606bf4ffacf`。
- 正式运行时 Node `22.17.1`。Provider Adapter `83/83`、Database `28/28`、Control API
  `105/105`、POOL-027 定向 `6/6`；`model-discovery.ts` statement／line／function
  `100%`、branch `94.11%`；TypeScript、ESLint、全生产构建、架构、源文件体量和重复率
  均通过。
- 发布 release：`/Users/stephen/releases/qianliu-zhisuan-pool027-a49ca355-20260803`；发布前
  备份：`/Users/stephen/backups/qianliu-zhisuan/pre-pool027-20260803-201040.dump`，SHA-256
  `766052f4cd095578745dc5ca0202c0b163a707ca574b59d4850a943c86d5b688`。迁移执行 0 项，
  最新迁移保持 `0037_client_identity`。
- 健康检查：Control API、Gateway、Worker、PostgreSQL、Redis、Web、Caddy 全部在线；
  公网 `https://ic.qianliuai.com` 正常；启动日志未发现 fatal／panic／unhandled／uncaught。
- Kimi 生产资源 `e75fe982-c83b-46a7-9fcb-c7876754e5a9`：加密凭证成功解密但不发往
  Moonshot 开放平台，使用 `VERSIONED_CATALOG / kimi-coding-plan-2026-08-03` 同步成功；
  快照 `61af131a-9fd5-46fa-8c72-6771a3801119`，模型 `k3`、`k3-256k`、
  `kimi-for-coding`、`kimi-for-coding-highspeed`，资源状态 `ACTIVE → ACTIVE`。
- 智谱生产资源 `74f8cb60-1702-4125-9a2b-c81ce69988c9`：在 `DEGRADED` 状态下使用
  `VERSIONED_CATALOG / zhipu-coding_plan-2026-08-03` 同步成功；快照
  `5b775c1b-61b5-4d85-9c9f-ccb9dd56782f`，模型 `glm-5.2`、`glm-4.7`、`glm-4.6`，
  资源状态 `DEGRADED → DEGRADED`。
- Coding Plan 官方未提供可用订阅 Key 调用的 List Models 契约，所以这两次同步按设计不
  产生厂商公网请求；验证的是生产加密凭证可解、模式分流、版本化目录、降级状态门禁和
  快照持久化。真实推理能力已有 Kimi 生产账本证明；不伪称目录同步等于实时授权探测。
- 最终结论：POOL-027 生产业务验收通过并关闭。POOL-028 仍等待于滔在发布后发起一次
  WorkBuddy 真实请求，二者状态互不混淆。

## POOL-028 三端真实客户端验收

### WorkBuddy

- 客户端：WorkBuddy `5.2.5`。
- 请求 ID：`e062b6e0-3353-4919-b7de-3b967bbf9245`。
- 识别结果：`WORKBUDDY / 5.2.5 / VERIFIED_USER_AGENT / OBSERVED`。
- 规则版本：`2026-08-03.v1`。
- 账本：输入 `33,258`、输出 `171`、缓存 `12,800`、推理 `62` Token，`SETTLED`。

### Codex

- 客户端：官方 Codex CLI `0.146.0-alpha.9.2`，真实 Responses 请求。
- 客户端返回：`POOL028_CODEX_REAL_OK`，退出成功。
- 请求 ID：`8924a671-4608-42aa-a736-77585d570e9a`。
- 识别结果：`CODEX / 0.146.0-alpha.9.2 / VERIFIED_USER_AGENT / OBSERVED`。
- 规则版本：`2026-08-03.v1`。
- 账本：输入 `11,508`、输出 `40`、缓存 `1,536`、推理 `18` Token，`SETTLED`。

### Z Code

- 客户端：Z Code `3.6.5`。
- 代表性成功请求 ID：`b0e988ca-8e31-484e-8f3c-d392950f2074`。
- 识别结果：`ZCODE / 3.6.5 / VERIFIED_USER_AGENT / OBSERVED`。
- 规则版本：`2026-08-03.v1`。
- 账本：输入 `12,188`、输出 `322`、缓存 `9,216`、推理 `206` Token，`SETTLED`。
- 观察：Z Code 在完成最小提示后继续自主探索，产生多条追加请求，并执行了生产库只读
  `SELECT`。发现后已立即停止任务；未发现写操作。后续生产验收应使用无工具模式或专用
  只读目录，避免最小验证扩展为自主任务。

### 同一 Key 与页面闭环

- 三个真实客户端请求均归属于“李佳”，且生产记录中的 `principal_key_id` 一致。
- 用量账本正确展示 WorkBuddy、Codex、Z Code 的家族、版本和“User-Agent 观测”。
- Agent 下拉筛选包含 WorkBuddy、Codex、Z Code、Claude Code、仟流 IDE、其他、未知。
- 选择 WorkBuddy 后 URL 为 `/usage?agent_family=WORKBUDDY`，结果收敛为唯一 `1` 条真实
  请求，分页和请求级 Token 与生产账本一致。

### 业务口径修正与未满足项

经业务确认，于滔只使用 WorkBuddy，不使用 Codex 或 Z Code，因此不应要求他为了验收
配置并不属于其实际工作范围的客户端。本轮“李佳同一 Key”三端回归已经证明 WorkBuddy、
Codex、Z Code 的真实客户端识别、聚合、筛选和账本闭环。

最终关闭前只需于滔自行把自己的主体 Key 配入 WorkBuddy，发起一个受控最小请求；随后
核对该请求归属于滔、Agent 家族为 `WORKBUDDY`、版本与识别来源正确、Token 与账本已结算。
服务端只保存 Key 摘要，无法恢复于滔 Key 明文，本轮没有重置或替换其 Key。

2026-08-03 复核生产账本发现，于滔在当天 `10:21:26`～`10:31:55` 已有 `15` 条 Kimi
成功请求，均已生成结算记录，证明其主体 Key 与实际调用链路可用。但这些请求早于
`0037_client_identity` 随本次版本于 `18:54:48` 上线的时间，因此历史事实按设计保留为
`UNKNOWN / NONE / legacy`，不能倒推为 WorkBuddy 新识别规则已通过。上线后于滔请求数为
`0`，其中 `WORKBUDDY` 且已结算的请求数也为 `0`；仍需他在上线版本上再发起一次真实
WorkBuddy 请求，不能通过改写历史记录代替验收。
