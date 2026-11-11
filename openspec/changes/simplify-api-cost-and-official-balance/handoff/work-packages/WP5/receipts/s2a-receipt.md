# WP5 S2A 回执：R1 purchases 补退役（用户 2026-11-04 裁定）

日期：2026-11-04；基线：worktree `/Users/mac/Projects/仟流智算-api-decouple`，分支 `codex/simplify-api-cost-and-official-balance`，HEAD `d6550c9`（开工与收工同 HEAD，未提交）。

## 1. 实际改动清单（3 文件，共 +103/-9 行）

### 1.1 `apps/control-api/src/department-costs/routes.ts`（+9 行，唯一业务代码改动）

- **:228-236**：POST `/provider-resources/:id/purchases` 内、`PurchasePostSchema.safeParse` 成功分支之后（:225-227 的 400 判定后）、`createResourcePurchase` 调用（现 :237）之前，新增：
  ```ts
  if (body.data.purchase_type === "API_RECHARGE") {
    return reply.code(410).send({
      error: "api_funding_management_retired",
      message: "API 内部资金管理已退出，请使用官方账户余额与 API费用估算",
    });
  }
  ```
- error/message 与 `provider-finance.test.ts:894` 参数化合同（pf.test.ts it.each :896-937 断言块）逐字一致；位于所有 repo 分支（幂等回执/closed/mode_mismatch/not_found）之前，不查资源、不写任何表，模式无关。`PACKAGE_PURCHASE` 分支与 GET 端点零改动（GET 注册于 :200-217 原样）。

### 1.2 `apps/control-api/src/__tests-integration__/w20-department-costs.test.ts`（+100/-8 行）

- **既有用例迁移**（"采购记录 append-only，幂等重放不重复现金支出"，:931-997）：
  - 正路径 payload 由 `API_RECHARGE`＋apiResourceId 改为 `PACKAGE_PURCHASE`＋planResourceId（planResourceId 仍由该用例内创建，:941-944 原样）；description 改"9 月 Coding Plan 采购"，amount/currency/purchased_at/idempotency_key（`w20-purchase-create-001`）不变。
  - 迁移注释 :932-937：记录原因（AFR-01/AT-AFR-02/G22，POST purchases 统一 410）与日期 2026-11-04、引用用户裁定。
  - **断言全部保留**：201＋amount 8 位小数（新增并列 `purchaseType: "PACKAGE_PURCHASE"` 字段，系增强非替换）、幂等重放 200＋`replayed:true`＋同 id、amount 篡改 → 409 `idempotency_conflict`、跨企业 404、列表 total/cashTotals/items、operation_log 审计 `resource_purchase.create` 长度 1、`resource_purchase_record` UPDATE 55000 append-only 触发器（0048 表级触发器，purchase_type 无关，已核实）、未认证 GET 401。
  - **mode_mismatch 对照形态变化**：由"CP 资源＋API_RECHARGE"改为语义等价的"API 资源＋PACKAGE_PURCHASE"（同一 409 `purchase_type_mismatch` 断言；依据 writes.ts:262 判定式 `(mode==="API") !== (type==="API_RECHARGE")`，两形态等价）；已在 :932-937 注释记录。
- **新增用例**（:999-1073，命名含 AT-AFR-02/purchases）：`"AT-AFR-02 purchases：API_RECHARGE 一律 410 且零写入，未认证 401，PACKAGE_PURCHASE 不受影响"`，5 个子断言：
  1. API 资源＋API_RECHARGE（合法 body）→ 410＋error/message 逐字＋`resource_purchase_record`/`resource_purchase_idempotency`/`operation_log`（企业全域计数）三表前后零增量；
  2. CODING_PLAN 资源＋同一 API_RECHARGE payload → 410＋逐字合同（模式不影响判定）；
  3. 未认证 → 401（requireAuth 先行）；
  4. 复用历史幂等键 `w20-purchase-create-001`（上一用例 PACKAGE_PURCHASE 回执）发 API_RECHARGE → 仍 410（退役优先于幂等回放）＋零增量复验；
  5. 对照：CP 资源＋PACKAGE_PURCHASE → 201、`purchaseType`/amount 8 位/`replayed:false`（对照采购 purchased_at 落 2026-09-05，因本文件 :734 前序用例已将 2026-10 关账未重开，注释已记录）。

### 1.3 `openspec/changes/simplify-api-cost-and-official-balance/handoff/work-packages/WP2/retired-api-funding-contract.md`（+2/-1 行）

- **:3** 版本行：`版本：v1.1（WP5 追加，2026-11-04：§2 表格增补 W12——purchases R1 补退役）；日期：2026-11-03（v1.0）；…`（其余内容原样）。
- **:35** §2 总表 W11 之后追加 W12 行：`POST /provider-resources/:id/purchases | 两者 | R1 补退役（WP5，用户 2026-11-04 裁定）：purchase_type=API_RECHARGE → 410（优先于幂等回执/closed/mode_mismatch，零写入）；PACKAGE_PURCHASE 保留 | API 类型 410 同上；PACKAGE 原合同`。文档其余内容零改动（§2 标题"19 写入口"未改，按合同"不改该文档其他内容"执行——W12 后实际条目 20，属已知遗留口径差异，见 §4）。

## 2. 实际执行的验证命令与结果

1. 合同指定命令（原样执行，收工后最终态复跑）：
   ```
   corepack pnpm@11.11.0 --filter @qianliu/control-api run test:integration -- src/__tests-integration__/w20-department-costs.test.ts
   ```
   结果：**43 个测试文件全过、360/360 用例全绿**（Duration 95.36s）。注意：该命令因 `apps/control-api/package.json:13` 脚本本身含 `src/__tests-integration__` 目录参数，追加路径被 vitest 作并集过滤，实际带跑了全部集成测试文件（非仅 1 个文件）。
2. 单文件精确运行（为满足"只跑指定文件"，直接调 vitest 同配置）：
   ```
   corepack pnpm@11.11.0 exec vitest run --config ../../vitest.config.ts src/__tests-integration__/w20-department-costs.test.ts   （cwd: apps/control-api）
   ```
   结果：**1 文件 10/10 用例全绿**（迁移用例＋新增 AT-AFR-02 用例在内，Duration ~6s）。
3. 合同指定命令：
   ```
   corepack pnpm@11.11.0 --filter @qianliu/control-api run typecheck
   ```
   结果：**exit code 0**（tsc --noEmit 无错误；仅 pnpm 报 node v22.17.1 与 wanted `>=22.23.4` 的引擎 WARN，与本次改动无关）。

### 过程中的中间失败（已修复，最终全绿）

- 中间态曾 2 失败：① 断言误用 snake_case `purchase_type`——`purchaseView`（writes.ts:61-72）序列化为 camelCase `purchaseType`，已改 camelCase；② 对照用例误落 2026-10（该月已于前序用例 :734 关账未重开 → 409 bill_closed）且替换时误删 `currency: "CNY"`（→400 invalid_request），已改 2026-09-05 并恢复 currency。修复后单文件与全量（合同命令）均绿。

## 3. 用例数（预期/实际）

- 目标文件预期 ≥9（原 9 用例）＋1 新增 ＝ 10；实际 10/10 通过。
- 合同命令并集口径：43 文件 360/360 通过（含本文件 10 例）。
- typecheck：0 错误。

## 4. 未解决问题 / 遗留口径说明

1. **§2 标题计数**：退役合同 §2 标题仍为"19 写入口处置总表"，追加 W12 后实际 20 条；按合同"不改该文档其他内容"未动标题，建议后续维护者决定是否改为"20"或加"（含 W12）"。
2. **410 与 `closed` 的显式断言**：新用例对照采购特意避开 2026-10 关账月，故"410 优先于 closed"未被独立断言（现由路由顺序保证：410 判定在 repo 之前；API_RECHARGE 落关账月也返回 410 已被子断言 1/2 隐式覆盖——retiredPayload 即 2026-10 日期）。如需显式断言可在后续电池补。
3. **WP4 页面侧**：purchases 表单对 `purchase_type=API_RECHARGE` 的前端入口隐藏/禁用属 WP4 范围，本次未动 web（合同禁止）。

## 5. 禁止事项遵守确认

- 改动仅限合同三文件；`contracts.ts`/`writes.ts`/迁移/其他测试/web 零改动（git status 仅上述 3 个 modified，WP5 notes/plan.md 为开工前已存在的未跟踪文件）。
- 未提交 git；未进入主仓 `/Users/mac/Projects/仟流智算`。
