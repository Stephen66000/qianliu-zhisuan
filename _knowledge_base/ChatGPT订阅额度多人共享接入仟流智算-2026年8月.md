# ChatGPT Pro 订阅额度多人共享接入仟流智算 — 实施方案

- 撰写时间：2026-08-01（Asia/Shanghai）
- 目标：把一个 ChatGPT Pro（$200/月）订阅账号的额度，通过仟流智算网关分发给 2–3 名同事使用，调用 GPT-5.6 Sol。
- 关联文档：
  - `仟流智算v0.3与Sub2API及TokenHub差异-2026年7月.md`（产品边界与 license 现状）
  - `开源代码学习与独立实现边界-2026年7月.md`（净室实现与许可证边界）
- 说明：本文是工程实施方案，不替代针对具体发布方式的正式法律意见。

---

## 一、为什么必须走这条路：经济账

GPT-5.6 Sol API 定价：**input $5/百万 token，output $30/百万 token**。

按"一个订阅账号一个月跑满 ≈ 60 亿 token"估算（来源：Codex 周限额极限约 14.8 亿 token，月化 60 亿+）：

| output 占比 | 月 API 费用 | 相当于 Pro $200 的 |
|---|---|---|
| 5%（偏输入对话） | ~$37,500 | 188 倍 |
| 12%（典型对话） | ~$48,000 | 240 倍 |
| **15%（编码/长输出，中位现实）** | **~$52,500** | **263 倍** |
| 25%（重度长输出） | ~$67,500 | 338 倍 |

**结论：官方 API 在这个用量下根本用不起。** 一年是 $60 万级别 vs 订阅 $2,400。价差决定了对订阅额度的访问能力不是"锦上添花"，而是"用得起"的前提。这是本方案存在的根本动因。

---

## 二、总体架构：进程外隔离，保证仟流智算独立性

```
┌──────────────────────────────────────────────────────────────┐
│  同事 A/B/C                                                   │
│  （各持仟流智算下发的 sub-key，用任意 OpenAI 兼容客户端）       │
└───────────────────────────┬──────────────────────────────────┘
                            │ 标准 /v1/chat/completions
                            ▼
┌──────────────────────────────────────────────────────────────┐
│  仟流智算 Gateway（产品本体，100% 自有代码，零第三方 license）  │
│  - 认证 / 限流 / 计量 / 账本                                   │
│  - 按 base_url 路由到上游                                      │
│  - Pro 撞限 → failover 到官方 API                             │
└───────────┬───────────────────────────────────┬──────────────┘
            │                                   │
   base_url │ http://127.0.0.1:xxx/v1           │ https://api.openai.com（兜底，要花钱）
            ▼                                   ▼
┌──────────────────────────────┐    ┌──────────────────────────┐
│  访问层（独立部署的进程，      │    │  OpenAI 官方 API         │
│  不属于仟流智算代码库）        │    │  （pay-as-you-go）       │
│  - 持有 Pro 账号凭证           │    │                          │
│  - 处理 PoW / token 刷新      │    │                          │
│  - 暴露 OpenAI 兼容接口        │    │                          │
└──────────────────────────────┘    └──────────────────────────┘
```

**独立性靠这条边界保证：**

- 仟流智算只对一个 `http://127.0.0.1:xxx/v1/chat/completions` 说话，标准协议、标准 Bearer 鉴权。
- 访问层是什么、基于什么实现、什么 license，与仟流智算**代码库完全无关**——它是进程外的一个 HTTP 端点，不是被 vendor 进来的代码。
- 这和"把第三方代码并入产品"是两个完全不同的法律情形：进程外调用不产生衍生作品关系，仟流智算的 license 不会被传染。

**这条边界还有第二层价值：** 将来访问层无论是升级、更换，还是替换成自研净室实现（路线 B），只要还暴露同样的 `/v1/chat/completions`，**仟流智算一行代码都不用改**。迁移成本趋近于零。

---

## 三、落地步骤

### 第 1 步（决定成败）：验证并部署访问层

这是整套方案的前提，也是不确定性最高的一步。**先验证它能跑，再谈接入仟流智算。**

#### 3.1.1 访问层是干什么的

访问层是一个独立进程，它的职责是把"ChatGPT 网页/桌面端登录后的会话能力"转成 OpenAI 兼容的 API。它要解决四件事：

1. **凭证持有与刷新**：持有 Pro 账号的 session（access_token），自动刷新，避免手动粘贴。
2. **PoW（工作量证明）求解**：OpenAI 在发起会话前要求解一道算力题（Sentinel/Arkose 系），这是访问层最核心、也最容易失效的部分。
3. **后端调用**：拿 token + 解出的 PoW，打 `chatgpt.com/backend-api/conversation`，取流式响应。
4. **协议转换**：把上述请求/响应包装成标准 `/v1/chat/completions` 对外暴露。

#### 3.1.2 选型现状（务必自行复核，2026 年情况变动快）

- **TokenHub**（Apache-2.0）：许可友好，但经核实**不做网页逆向**——它的 Codex 订阅走官方 OAuth。能做企业 Gateway 治理，但解决不了"网页订阅转 API"这一层。**不适合作为本方案的访问层。**
- **Sub2API**（LGPL-3.0，README 另声明"无商业授权"）：功能上覆盖订阅账号池转 API。许可有表述冲突，但**在"公司内部自用、不对外分发软件、不商业运营"的场景下，copyleft 的分发义务不易触发**；且仟流智算是进程外调用，不构成代码层面的衍生关系。可作为内部 PoC 的候选，但当前 PoW 是否仍有效需实测。
- **acheong08/ChatGPT 等老项目**：多已 archived，跟不上 PoW 更新，不推荐。

> 选型原则：优先选仍在近期更新、issue 区有"近期可用"反馈的项目。PoW 机制 OpenAI 频繁改，半年不更新的项目大概率失效。

#### 3.1.3 验证清单（部署后逐项确认，全部通过才进入第 2 步）

| # | 验证项 | 通过标准 |
|---|---|---|
| 1 | 访问层能登录并拿到有效 access_token | 返回 200，token 可用 |
| 2 | PoW 能解（最关键） | 不被 403/429 挡住 |
| 3 | 能调用 GPT-5.6 Sol | 返回正常 completions |
| 4 | 流式响应正常 | SSE 不中断 |
| 5 | 并发 2–3 个请求 | 不互相挤崩 |
| 6 | 跑半小时观察 | 无突发封号/验证弹窗 |

**第 1、2 项失败 = 访问层失效，整套方案暂停。** 这是必须先过的关。

#### 3.1.4 license 处理（内部自用场景）

- 访问层作为独立进程部署，不并入仟流智算代码库。
- 部署时保留所选项目的 LICENSE、版权声明、归属（attribution）。
- "无商业授权"类表述若与 license 正文冲突，在内部自用、不分发、不对外售卖的前提下风险可控；一旦未来对外提供商业服务，必须先取得权利人书面确认或更换实现。

---

### 第 2 步：接入仟流智算（访问层验证通过后）

访问层暴露的是标准 OpenAI 兼容接口，和现有 DeepSeek caller 协议一致。接入仟流智算只需四项改动。

#### 3.2.1 数据库：给 provider_resource 加 base_url 列

当前 `provider_resource` 表没有 `base_url` 列（迁移 `0005_provider_resource_route.js`），上游地址在 `http-caller.ts:41` 硬编码为 `https://api.deepseek.com/chat/completions`。

新增迁移：给 `provider_resource` 加 `base_url TEXT NULL`。

- DeepSeek 资源：`base_url` 填 `https://api.deepseek.com`（或不填，回退默认）。
- Pro 订阅资源：`base_url` 填 `http://127.0.0.1:xxx/v1`（访问层地址）。
- 官方 OpenAI API 资源：`base_url` 填 `https://api.openai.com`。

> **为什么是加列而不是写 if 分支**：加 `base_url` 列是一次性投入、终身收益——以后任何 OpenAI 兼容上游（Groq、Together、自建中转）都只是"配一行数据"，零代码改动。

#### 3.2.2 http-caller 改造：地址从 resource 读

- `AdapterResource` 接口（`packages/provider-adapters/src/index.ts`）增加 `baseUrl?: string` 字段。
- `real-pipeline.ts` 在构造 resource 时（约 324–335 行），从 `provider_resource` 读出 `base_url` 填入。
- `http-caller.ts`（41 行）由硬编码改为：`const base = resource.baseUrl ?? "https://api.deepseek.com"`，拼接 `/chat/completions`。

这样 DeepSeek caller 变成通用 OpenAI 兼容 caller，DeepSeek 资源和 Pro 订阅资源走同一套逻辑、不同地址。

#### 3.2.3 provider 注册：自起名，保持产品身份

`adapter-registry.ts` 的 switch（31–40 行）当前只有 deepseek/zhipu/kimi。

- 新增 provider 记录，**code 自起名**，建议 `openai_subscription`（语义自洽：它是订阅，不是 API）。
- 由于协议与 DeepSeek 一致，switch 里 `openai_subscription` 可复用 DeepSeek 的 adapter（OpenAI 兼容）；将来官方 API 再加 `openai_api` provider，互不冲突。
- **产品命名上不出现任何第三方项目名**，满足独立性要求。

#### 3.2.4 provider_resource 与 model_route 配置

Pro 订阅资源行（核心字段）：

| 字段 | 值 | 说明 |
|---|---|---|
| `provider_id` | 指向 code=openai_subscription 的 provider | |
| `mode` | `CODING_PLAN` | **必须**：ChatGPT Pro 是订阅套餐，语义上是 PACKAGE_INCLUDED；且只有 CODING_PLAN 模式才走并发门禁（见下） |
| `credential_type` | `SUBSCRIPTION_SESSION` | 已有枚举，语义正确 |
| `concurrency_limit` | `3` | **真正生效的并发拨杆**（见 3.2.5） |
| `base_url` | `http://127.0.0.1:xxx/v1` | 访问层地址 |

model_route：给统一模型 `gpt-5.6-sol` 挂两条候选：

| 候选 | provider | priority | 作用 |
|---|---|---|---|
| 主 | openai_subscription | 高 | 吃 Pro 额度 |
| 兜底 | openai_api（官方） | 低 | Pro 撞限自动切换 |

`maxAttempts` 已为 2（main.ts:66），够一次 failover。

---

## 四、并发与限流：你担心的"排队"问题，机制已就绪

核实代码后的关键结论：

**真正的并发控制不是 `http-caller`，而是 DB 层的租约机制**（`QuotaGateRepository.acquireLease`）：

```
读 provider_resource.concurrency_limit
  → 数 concurrency_lease 表里该资源"未释放"的租约
  → 数 >= limit → 返回 null → 这条资源被排除，自动 failover
  → 数 <  limit → 插租约，放行
```

> 注：`real-pipeline.ts:330` 传入的 `concurrencyLimit: 100` 是**死代码**，真实 caller 不读它。真正生效的是 `provider_resource.concurrency_limit` 列 + 租约计数。改 DB 列即可，无需改这行。

**配 `concurrency_limit = 3` 的行为，正好是你要的：**

| 情形 | 行为 | 同事体感 |
|---|---|---|
| 2–3 人同时发 | 3 个并发位都进 | 不排队，直接用 |
| 偶发第 4 个并发 | acquireLease 返回 null，Pro 通道排除，自动 failover 到官方 API | 几秒内切到兜底，几乎无感 |
| Pro 窗口额度撞 5h 上限 | 上游返 429 | `isSwitchable` 判定 429 可切换，切官方 API |

**这不是"排队失去意义"的那种死队**，而是"并发位 + 自动回退"。3 人错峰用基本不触发 failover，偶尔触发也几乎无感。

但需注意：**CODING_PLAN 模式才会走 acquireLease**（real-pipeline.ts:266 的 `if` 判断）。这也是为什么 Pro 资源必须配 `mode=CODING_PLAN`——不只是计费语义对，并发门禁也只有这个模式会生效。

---

## 五、风险与维护

| 风险 | 性质 | 应对 |
|---|---|---|
| **PoW 失效** | OpenAI 改算法，访问层解不动 → 整条 Pro 通道挂 | 这是最大维护点。访问层失效时 failover 到官方 API 兜底（要花钱，但保可用） |
| **账号风控/封号** | 多设备、异地、高频触发验证甚至停号 | 全程同一公司 IP、2–3 人错峰、不对外，降低触发概率 |
| **违反 ToS** | 账号共享 + 逆向接口都在禁止范围 | 内部低调自用，风险可控；绝不对外售卖或公开运营 |
| **窗口额度被 3 人共花** | 比 1 人独用更快撞 5h 上限 | 靠官方 API failover 兜底，体感无缝 |
| **token 过期** | access_token 几小时失效 | 选支持自动刷新的访问层；或定时刷新任务 |

**核心认知：访问层是整套方案里唯一脆弱、需要持续维护的部分。** 仟流智算网关本身是稳的，它只对一个 HTTP 端点说话。

---

## 六、将来切净室实现（路线 B）的路径

本方案已把边界卡死在"OpenAI 兼容接口"那一层，所以阶段 B 是无痛替换：

1. 调研 PoW/token/backend-api 的**机制**（方法与事实，不受版权保护），不复制源码。
2. 按仟流智算自己的结构实现访问层（净室），仍暴露 `/v1/chat/completions`。
3. **替换部署**：把旧的访问层进程换成新的，`base_url` 不变。
4. **仟流智算零改动**。

依据：`开源代码学习与独立实现边界-2026年7月.md` 已确立"学习思想、独立实现、不复制表达"的规则。

> 阶段 B 不必现在做。先用阶段 A 把"真实使用下的维护成本"摸出来——哪些 PoW 变更要跟、多久失效一次、3 人实际用量曲线——这些才是 B 能否长期维持的决定性输入。

---

## 七、第一步行动清单

1. **选定并部署一个访问层**，内部跑起来。
2. **跑通验证清单（3.1.3 六项）**——全部通过才往下走。第 1、2 项（token + PoW）是生死线。
3. 验证通过后，做仟流智算接入改动：加 `base_url` 列迁移 → http-caller 改造 → 注册 openai_subscription → 配 provider_resource（CODING_PLAN, concurrency_limit=3）→ 配 model_route 双候选。
4. 2–3 名同事挂上用，观察一周：并发是否够、Pro 撞限频率、failover 是否生效、有无风控信号。

**关键判断点在第 2 步。** 它通过，整套方案成立；它不通过，本方案暂停，回到"是否值得自研 PoW solver"的决策。
