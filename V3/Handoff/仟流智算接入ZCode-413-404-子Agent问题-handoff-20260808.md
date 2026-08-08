# 仟流智算接入 ZCode 问题排查与修复 Handoff

| 项目 | 内容 |
| --- | --- |
| 编写日期 | 2026-08-08 |
| 编写人 | 佳哥（会话操作）+ ZCode（排查与修复） |
| 交接对象 | 同事（继续分析与处置） |
| 涉及系统 | 仟流智算 gateway（macmini Docker）、ZCode 客户端（笔记本）、frp 隧道、智谱 GLM-5.2 |
| 仓库 | `/Users/mac/Projects/仟流智算`（main 分支，已 push GitHub） |

---

## 0. 一句话总结

用户用仟流智算的 key 接入 ZCode（智谱 GLM-5.2），遇到**四个叠加的问题**：413（已修复部署）、404（已修复配置）、autocompact 爆炸（已修复 context 配置）、子 Agent 不可用（判断为 ZCode 客户端限制，待确认）。前三个已解决，第四个需要进一步分析。

---

## 1. 问题一：413 FST_ERR_CTP_BODY_TOO_LARGE（✅ 已修复并部署）

### 现象
- 生产报错：`provider=c4b5b890... model=qianliu-zhipu-glm-5-2 status=413 reason=unknown`
- 用官方 coding-plan API 直连智谱正常；走仟流 gateway 几轮对话即 413

### 根因
- `apps/gateway/src/server.ts` 的 `Fastify({...})` **未设 bodyLimit**，吃 Fastify 5.8.5 默认 **1MB**
- ZCode 每轮发累积上下文，长会话几轮超 1MB，在 `application/json` 解析阶段（进路由前）被拒
- gateway 原本无 `setErrorHandler`，Fastify 原生 413 走默认 JSON，被日志记成 `reason=unknown`
- 与智谱无关、与 provider 无关——任何 provider 的长请求都会撞

### 修复（commit `21e5a20`，已部署 macmini）
1. **bodyLimit 抬到 10MB**（env `GATEWAY_REQUEST_BODY_LIMIT_BYTES` 可配）
2. **setErrorHandler** 拦 `FST_ERR_CTP_BODY_TOO_LARGE` → OpenAI envelope + `code=payload_too_large`
3. **control-api** 同款 bodyLimit
4. **历史截断安全网**（② 默认关闭，env 成对启用）：`GATEWAY_HISTORY_TRUNCATE_AT_TOKENS` + `GATEWAY_HISTORY_KEEP_TOKENS`
5. **readPositiveIntEnv** 抽到 `@qianliu/config`（gateway/control-api 共享）

### follow-up（commit `84c11ed`，已部署 macmini）
- F-2 keepTokens off-by-one、F-3 反向 tool 配对、G-1/G-2 断言强化、B-1 errorHandler 日志

### 部署
- macmini run-release 脚本：`V3/Evidence/Production-Release/20260807-hotfix413/` + `20260807-hotfix413-followup/`
- 线上版本：`ca77666`（`/Users/stephen/releases/qianliu-zhisuan-hotfix413-followup-ca77666-20260807/`）
- 验证：用户确认不再 413

### 审核状态
- 两轮代码审核（报告：`V3/Evidence/gateway-body-limit-413-历史截断-代码审核报告-20260807.md`）
- P1 清零，72 单测全过
- 合规缺口：独立性 I1（同模型同会话），用户决定不补 I2

---

## 2. 问题二：404 Not Found（✅ 已修复配置）

### 现象
- ZCode Q/A 任务报 `status=404 Not Found`
- gateway 日志无业务请求（只有 /health）

### 根因（多层，需逐一确认）
**根因 A — ZCode base URL 多了 /v1：**
- ZCode 配置 base URL `https://gw.qianliuai.com/v1`
- ZCode 用 Anthropic Messages 格式，自动拼 `/v1/messages`
- 最终路径 `/v1/v1/messages`（双层 v1）→ gateway 无此路由 → 404
- **修复**：base URL 改为 `https://gw.qianliuai.com`（去掉末尾 /v1）

**根因 B — ZCode provider context limit 配成 256：**
- `~/.zcode/v2/config.json` 中仟流智算GLM provider：
  ```json
  "limit": { "context": 256 }  // 应为 1000000
  ```
- 对比官方 provider：`"context": 1000000`
- 256 token 导致 autocompact 反复触发熔断器，请求可能未正常发出
- **修复**：context 改为 1000000

**根因 C — frpc 隧道曾有 router config conflict：**
- frpc.ini 位置：`/Users/stephen/Services/frp/0.38.0/frpc.ini`
- launchd 服务：`com.stephen.upwall-frpc`
- 曾报 `router config conflict`（frps 端 47.111.66.55 同名 proxy 冲突）
- **但 `--resolve` 直连 frps 测试返回 401（隧道实际通的）**，conflict 可能是历史残留或已自愈
- **未最终确认 conflict 是否彻底解决**

### 当前状态
- base URL + context limit 修复后，404 不再出现
- frp 隧道 `--resolve` 测试通（401），但 conflict 日志待确认

### 待办（frp）
- 确认 frpc 日志不再报 `router config conflict`
- 若仍 conflict，需登录 frps（`47.111.66.55`）查谁占了 proxy 名（用户无 ssh 权限）
- frpc.ini 关键配置（已确认正确）：
  ```ini
  [qianliu_gateway_v2]
  type = http
  local_ip = 127.0.0.1
  local_port = 8787
  custom_domains = api.qianliuai.com,gw.qianliuai.com
  ```

---

## 3. 问题三：autocompact compact_rapid_refill_breaker（✅ 已修复）

### 现象
- ZCode 报 `Autocompact stopped because the context refilled within fewer than 3 tool turns`
- 新开会话也触发

### 根因
- **直接原因**：ZCode provider 的 context limit 配成 256（见问题二根因 B）
- 256 token 压缩完一执行工具又满 → 连续 3 次 → 熔断器
- 改成 1000000 后解决

### 次要因素（项目大文件，建议后续处理）
- `V3/仟流智算-测试问题蓄水池.md` = **189KB**（项目最大 markdown）
- `参考/` 目录 73M（sub2api-main + TokenHub 第三方源码）
- V3 文档总计 18404 行
- ZCode "并行读取核心文件"时会注入大量内容

### 已做的清理
- 删除 `_wt/`（529M git worktree 副本）、`_tmp_*`、`coverage/`、`.DS_Store`
- 释放约 529M

---

## 4. 问题四：子 Agent 不可用（❌ 待分析）

### 现象
- 官方 key（`builtin:bigmodel-coding-plan`）的 ZCode 会话**可以**调用子 Agent（Agent 工具）
- 仟流 key（`source: custom`）的 ZCode 会话**不触发**子 Agent

### 当前判断（未最终确认）
- ZCode 客户端可能**只对内置 provider（`builtin:*`）开放 Agent 工具**
- 自定义 provider（`source: custom`）可能默认不挂 Agent 工具
- 非仟流 gateway 问题（gateway 日志无子 Agent 请求 = ZCode 没发起）

### 待确认
1. 仟流 key 会话的工具列表里有没有 "Agent" 工具
2. ZCode 文档/设置里是否有"自定义 provider 启用 Agent"开关
3. 是否是 ZCode 版本差异（当前 v3.7.3）

### 相关配置（供分析）
```
官方 provider: builtin:bigmodel-coding-plan, kind=anthropic, source 内置
仟流 provider: c4b5b890-..., name=仟流智算GLM, kind=anthropic, source=custom
仟流 provider: 1555f2bd-..., name=仟流智算-李佳, kind=openai-compatible, source=custom
```

---

## 5. ZCode 客户端关键配置（`~/.zcode/v2/config.json`）

### 仟流智算GLM（报 404/413 的那个，已修复）
```json
{
  "name": "仟流智算GLM",
  "kind": "anthropic",
  "source": "custom",
  "options": {
    "apiKey": "sk-qianliu-***",
    "baseURL": "https://gw.qianliuai.com"    // 已去掉 /v1
  },
  "models": {
    "qianliu-zhipu-glm-5-2": {
      "limit": { "context": 1000000 }         // 已从 256 改为 1000000
    }
  }
}
```

### 仟流智算-李佳（Kimi，openai 格式）
```json
{
  "name": "仟流智算-李佳",
  "kind": "openai-compatible",
  "source": "custom",
  "options": {
    "baseURL": "https://gw.qianliuai.com/v1"  // openai 格式带 /v1 是对的
  },
  "models": {
    "qianliu-kimi-k3": { "limit": { "context": 200000 } }
  }
}
```

### 官方 bigmodel-coding-plan（对比基准）
```json
{
  "kind": "anthropic",
  "source": "custom",  // 但实际是内置 builtin
  "options": { "baseURL": "https://open.bigmodel.cn/api/anthropic" },
  "models": {
    "GLM-5.2": { "limit": { "context": 1000000, "output": 131072 } }
  }
}
```

---

## 6. 网络拓扑

```
ZCode（笔记本 mac@Stephen-macbook）
  ↓ https://gw.qianliuai.com
  ↓ （笔记本代理软件 fake-ip 198.18.x.x，但实际走代理转发）
frps（47.111.66.55:7000，公网）
  ↓ frp http 隧道
frpc（macmini，launchd: com.stephen-upwall-frpc，PID 随重启变化）
  ↓ local_ip 127.0.0.1:8787
gateway（Docker: qianliu-zhisuan-gateway-1）
  ↓ openai-compatible-caller
智谱 GLM-5.2 上游
```

### 关键验证命令
```bash
# 绕过代理直连 frps 测隧道（应返回 401）
curl -sS -k -o /dev/null -w 'status=%{http_code}\n' \
  --resolve gw.qianliuai.com:443:47.111.66.55 \
  https://gw.qianliuai.com/v1/models -H "Authorization: Bearer test"

# gateway 健康检查
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8787/health  # macmini 本地

# gateway 日志查请求
docker logs --since 10m qianliu-zhisuan-gateway-1 2>&1 | grep -E "incoming|completed|404|413"

# frpc 状态
ps aux | grep frpc | grep -v grep
tail /Users/stephen/Services/frp/0.38.0/frpc.log
```

---

## 7. macmini 环境

| 项 | 值 |
| --- | --- |
| 用户 | stephen |
| 系统 | macOS（darwin） |
| gateway 版本 | commit `ca77666`（hotfix413-followup） |
| 数据库迁移 | `0041_provider_quota_window`（本次未迁移） |
| release 目录 | `/Users/stephen/releases/qianliu-zhisuan-hotfix413-followup-ca77666-20260807/` |
| release 指针 | `/Users/stephen/qianliu-current-release.txt` |
| 回滚镜像 | `qianliu-rollback-ca77666-*`（回退到 21e5a20） |
| frpc | `/Users/stephen/Services/frp/0.38.0/frpc`，launchd `com.stephen-upwall-frpc` |
| frps | `47.111.66.55:7000`（公网，用户无 ssh 权限） |

---

## 8. 代码变更清单（main 分支，已 push GitHub）

| commit | 内容 |
| --- | --- |
| `21e5a20` | ① bodyLimit 10MB + 413 错误归因 + ② 历史截断 + readPositiveIntEnv 共享（squash） |
| `1a91dde` | run-release 脚本（hotfix413） |
| `84c11ed` | follow-up：F-2/F-3/G-1/G-2/B-1 修复 |
| `ca77666` | 审核报告修正（项目已有质量门禁配置） |
| `5535a9e` | run-release 脚本（hotfix413-followup） |

### 改动文件
- `apps/gateway/src/server.ts` — bodyLimit + setErrorHandler
- `apps/gateway/src/plugins/error-envelope.ts` — PAYLOAD_TOO_LARGE → 413
- `apps/gateway/src/pipeline/history-truncation.ts` — 截断核心（新增）
- `apps/gateway/src/pipeline/real-pipeline.ts` — 接入截断 + effectiveBody
- `apps/gateway/src/main.ts` — 注入 truncationConfig
- `apps/control-api/src/server.ts` — bodyLimit
- `packages/domain/src/index.ts` — ERROR_CLASSIFICATION
- `packages/config/src/index.ts` — readPositiveIntEnv

---

## 9. 遗留问题与建议（交接重点）

### 高优先级
1. **子 Agent 不可用**：确认是否 ZCode 对 custom provider 的限制。如果是，查 ZCode 文档/设置或向 ZCode 反馈。这是用户体验差异的核心（官方 key 能并行，仟流 key 不能）。
2. **frpc router config conflict**：确认是否已自愈。若仍冲突，需联系有 `47.111.66.55` ssh 权限的人查 frps 端谁占了 proxy 名。

### 中优先级
3. **ZCode provider 配置文档化**：把正确的 baseURL（不带 /v1）+ context limit（1000000）+ kind（anthropic）做成接入文档，避免下次配错。
4. **项目大文件治理**：`参考/`（73M）移出项目目录；`V3/仟流智算-测试问题蓄水池.md`（189K）考虑拆分。减小 ZCode 读项目时的上下文注入。

### 低优先级
5. **gateway 413 审核合规**：当前独立性 I1，如需正式 V1.4 Audit PASS 需补 I2。
6. **follow-up P2/P3**（审核报告 §7.2）：F-2/F-3/G-1/B-1 已修，剩余 D-1（413 未回显 limit 值）等。

---

## 10. 时间线

| 时间 | 事件 |
| --- | --- |
| 8/7 早 | 生产报 413 |
| 8/7 | 诊断根因 → 实现 bodyLimit + 截断 → 两轮审核 → 部署 hotfix413（21e5a20） |
| 8/7 22:46 | 部署成功，验证不再 413 |
| 8/7 23:00 | 报 404 → 查 frp → frpc conflict → 重启 frpc |
| 8/7 23:05 | 部署 follow-up（84c11ed/ca77666） |
| 8/8 早 | 发现 ZCode context limit=256 → 改为 1000000 |
| 8/8 | base URL 去掉 /v1 → 404 解决 |
| 8/8 | 发现子 Agent 不可用 → 判断为 ZCode custom provider 限制 |
| 8/8 | 编写本 handoff |
