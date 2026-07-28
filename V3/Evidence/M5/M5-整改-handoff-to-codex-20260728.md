# 仟流智算 M5 双审整改 —— Codex 交接

> **交接日期**：2026-07-28
> **交接人**：Claude（K5，M5 实现方 + 整改第一批）
> **接手人**：Codex
> **背景**：M5 双审 Reviewer（Codex 独立会话）判 **NOT_READY**（5 P1 + 3 P2），佳哥决定**全部整改**。Claude 已完成一批，K3 额度不足，剩余移交 Codex。
> **一句话**：M5 桌面 Web 管理后台已交付并通过三硬门禁（集成 312 绿 + macOS/Win11 E2E 各 11/11），但双审发现实质缺口，需按 Reviewer 解除条件继续整改。

---

## 0. 项目与红线

- **项目根**：`/Users/mac/Projects/仟流智算`（本地仓库，**无远程，严禁 push/remote/PR**）
- **命令前**：`export PATH="$PWD/.corepack-bin:$PATH"`（corepack 缓存可能故障；关键命令可直调 `node_modules/.bin/xxx` 绕过）
- **质量门禁**（每 commit 前）：`pnpm typecheck` / `pnpm lint`（--max-warnings=0，零警告硬门禁）/ `pnpm test` / `pnpm build`
- **测试栈**：Vitest（单测 + Testcontainer 集成，需 Docker）+ Playwright（E2E，需 Docker + 浏览器）
- **硬约束**：前端只读消费后端，不在前端重算账本；视觉严格遵循仟流视觉规范（品牌色锁定、仟流青每视口 1-2 处、仪表盘字号三级收敛）

## 1. 当前状态（HEAD = `4840f44`）

**M5 三硬门禁已闭合**（2026-07-28 实跑）：
- 全仓 `pnpm -r run test` → **312 绿**（含 gateway 69 个 Testcontainer 集成测试）
- macOS Chrome E2E → **11/11**
- Win11 Chrome E2E → **11/11**

**双审整改已完成的 commit**（`9b28735` handoff 之后）：

| commit | 内容 | 对应发现 |
| --- | --- | --- |
| `fe69669` | P2-01 乐观锁改单调 version（迁移 0017）+ P2-02 quota_value zod 校验+DB CHECK + P2-03 format BigInt + 首页指标（可信度并入最早耗尽+资源状态卡）+ 对象锁生成器记 commit/封根配置 | P2-01/02/03 + 首页裁定 + P1-01 部分 |
| `681c1d3` | P1-05 告警独立 `alert_event` 表 + 生命周期（AlertEventRepository：evaluate 落库、最新快照、阈值注入、AUTO_RESOLVED 历史、脱离 reconciliation） | P1-05 |
| `b4de710` | P1-04 账本下钻逐 Attempt 计量明细（attempts 返回 metering/ledgerLines，前端展示） | P1-04 |
| `4840f44` | P1-02 部分：厂商独立管理（新企业可登记第一个厂商，修 WT-01 断点） | P1-02 部分 |

**双审报告全文**（Reviewer 发现 + 解除条件）：`V3/Evidence/M5/M5-双审任务书-20260728.md` §8。

## 2. 待办（Reviewer 解除条件，逐条）

### P1-02（剩余）—— 管理写操作进入 Web
> Reviewer：W19 声称的管理闭环没进 Web。当前 Principals 只有创建/停用；quota-rules 是占位壳；无 unified-model/route 管理入口。

**已完成**：Resources 页 Provider 独立管理（新建厂商 + 下拉来自 /providers）。

**待做**（`apps/web/src/pages/`）：
- **Principals.tsx**：主体 Key 创建/一次展示/重置（调 `POST /principals/:id/key`、`POST .../key/reset`、`GET .../key`），Key 明文一次展示交互（绝不回显/不入快照）；模型与额度分配（调 `POST /principals/:id/grants`、`GET .../grants`、PATCH grant）。
- **QuotaRules.tsx**：从占位壳改真实页（额度规则列表 + 创建/编辑；后端 `GET /billing-rules` 已存在，写操作需确认或补）。
- **unified-model / model-route 管理入口**：列表 + 创建/启停（后端 `POST /unified-models`、`POST /model-routes`、PATCH 已存在）。可放 QuotaRules 或新页。

**后端 API 已就绪**（`apps/control-api/src/{keys,grants,providers,admin-writes}/routes.ts`），前端只需补表单 + react-hook-form + 二次确认。

### P1-03 —— E2E 真实夹具 + 禁止条件跳过
> Reviewer：11/11 E2E 存在"绿但没执行目标行为"（WT-01 只填不提交、WT-05 接受空态、WT-10 无数据时跳过、README 把多个 WT 归为"非 Web"）。

**待做**（`apps/web/e2e/`）：
- 确定性夹具建真实 Provider/资源/主体/Key/Grant/请求/Attempt/账本/预测/调度/告警（可参考 `apps/control-api/src/__tests-integration__/w18-dashboard-usage.test.ts` 的 seedFullData 模式，或加 seed API/script）；
- **禁止 `if visible` 式跳过**；逐 WT 断言 API 副作用 + 页面结果；
- macOS + Win11 复跑。

### P1-01 —— 对象锁（剩余）
> 已修生成器（记 commit + 封根配置 + 生成器自身）。**剩余**：整改完成后重新生成锁并**提交进 Git**（当前锁文件是 untracked）。

**待做**：整改全部完成后 `python3 V3/tools/candidate_lock.py generate` + `git add` 锁文件。

## 3. 关键坑（别复踩）

1. **updated_at 乐观锁已废弃**：现用单调 `version` 列（迁移 0017）。前端 PATCH 携带 `expected_version`（int），不再是 `expected_updated_at`。
2. **告警不再是派生视图**：现用 `alert_event` 表（迁移 0017），`GET /alerts` 先 evaluate 落库。`?history=true` 分未处理/历史。disposition 的 `target_id` 是 uuid 列——alert_key 字符串只能放 change_summary。
3. **vite proxy SPA**：dev proxy 用 `Sec-Fetch-Mode: navigate` bypass，否则前端路由被代理到后端 JSON。已修，别动。
4. **Windows 迁移 ESM**：`migrator.ts` 用 `pathToFileURL` 包装（commit `f41c3cb`），Windows 盘符路径直接 import 会炸。
5. **凭证明文红线**：只一次提交/展示，绝不回显/入库/入快照。canary 扫表 0 命中是硬门禁。
6. **沙箱 node_modules 易坏**：本环境（Cowork VM）rollup/vite 原生模块常被宿主重装弄坏，跑不了 build/test；typecheck/lint 可用。**集成测试/E2E 必须在宿主机（macOS/Win11）跑**。

## 4. 门禁与验证

```bash
cd /Users/mac/Projects/仟流智算
export PATH="$PWD/.corepack-bin:$PATH"

# 开发期（沙箱/宿主机通用）
pnpm typecheck && pnpm lint

# 集成测试 + E2E（宿主机，需 Docker + 浏览器）
pnpm -r run test                                    # 应 312 绿
pnpm --filter @qianliu/web test:e2e                 # 应 11/11
```

**E2E 前置**（宿主机）：起 PG（`docker run -d -p 55432:5432 ...` 或连局域网）、`pnpm db:migrate`、`pnpm --filter @qianliu/control-api seed:admin --enterprise X --username admin --password admin123`、export F-02 三密钥（GATEWAY_KEY_PEPPER/CREDENTIAL_KEK/COOKIE_SECRET）。详见 `V3/Evidence/M5/M5-收口执行清单-20260728.md`。

## 5. 完成判定

全部 Reviewer 解除条件满足后：
1. 门禁全绿（typecheck/lint/build/test + 集成 + E2E macOS+Win11）；
2. 重新生成对象锁（含 commit）+ 提交进 Git；
3. 更新 `V3/Evidence/M5/`（整改 Evidence + 双审任务书签回）；
4. 交佳哥，重新进入 M5 双审。

**有任何疑问对照 `V3/Evidence/M5/M5-双审任务书-20260728.md` §8 的解除条件。**
