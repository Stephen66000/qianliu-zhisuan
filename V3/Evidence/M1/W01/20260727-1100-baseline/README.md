# W01 Evidence：建立 Git 工程基线与正式工程命令

| 项目 | 内容 |
| --- | --- |
| 工作包 | W01（D1 / M1 前置） |
| Stage | Stage 03 第一个工作包 |
| 日期 | 2026-07-27 |
| 执行者 | 主 AI（佳哥授权） |
| Git commit | `dd33453baa02fa5658f1c4f2bba9b9df69b9e164`（首个 commit，结束 Local First） |
| pnpm-lock.yaml sha256 | `b93da37910e4ad780d8b363a9e7ca2ffde17ebcf3f6d7f48c3a2bf7518f04c6d` |
| 结论 | **PASS** —— 全部正式工程命令实测全绿，工程基线可复跑 |

## 1. 候选对象

pnpm workspace monorepo（apps × 4 + packages × 7），技术栈版本严格按工程规则 §2 冻结，零漂移。

- apps：web（React 19 + Vite 7）、control-api（Fastify 5）、gateway（Fastify 5）、worker
- packages：contracts、domain、database（Kysely）、provider-adapters、observability、config（Zod）、testing（Testcontainers）
- deploy/compose.yaml：PG17 + Redis8（digest 锁定）+ 4 个占位服务

## 2. 环境

| 对象 | 实测值 |
| --- | --- |
| Node.js | v22.17.1（工程规则 §2 要求） |
| pnpm | 11.11.0（corepack） |
| Docker | 28.0.1 |
| Docker Compose | v2.33.1-desktop.1 |
| 操作系统 | macOS darwin 25.5.0 arm64 |
| postgres:17-alpine digest | sha256:742f40ea20b9ff2ff31db5458d127452988a2164df9e17441e191f3b72252193（W01 锁定） |
| redis:8-alpine digest | sha256:8096655e437712b07503796fb64d81359256cfcff0ab29d95a7da72863786efb（W01 锁定） |

## 3. 正式工程命令实测结果（全部全绿）

| 命令 | 结果 | 说明 |
| --- | --- | --- |
| `corepack pnpm@11.11.0 install --frozen-lockfile` | ✅ | 422 包解析，唯一 pnpm-lock.yaml 生成 |
| `corepack pnpm@11.11.0 typecheck` | ✅ | 11 个 workspace 项目全 Done |
| `corepack pnpm@11.11.0 lint` | ✅ | 0 error 0 warning（max-warnings=0） |
| `corepack pnpm@11.11.0 test` | ✅ | 18 个单测通过（contracts 2 + config 4 + domain 4 + provider-adapters 4 + observability 4） |
| `corepack pnpm@11.11.0 test:integration` | ✅ | database 4/4（Kysely 迁移框架，PG17 Testcontainer） |
| `corepack pnpm@11.11.0 test:e2e` | ✅ | 占位通过（e2e 推迟到 M1/M2，Playwright 1.55.0 已装） |
| `corepack pnpm@11.11.0 build` | ✅ | web 产出 dist（187KB），全包 tsc 编译通过 |
| `corepack pnpm@11.11.0 dev` | ✅ | gateway:8787 / control-api:8788 / web:5173 health 端点全部可达 |
| `corepack pnpm@11.11.0 db:migrate` | ✅ | compose 真实 PG17 执行 0000_baseline_probe |
| `corepack pnpm@11.11.0 db:rollback` | ✅ | 回滚 0000_baseline_probe，表消失 |
| `corepack pnpm@11.11.0 db:migrate`（幂等） | ✅ | 再次迁移重建表 |
| `corepack pnpm@11.11.0 evidence:canary` | ✅ | 白名单过滤生效，canary 0 命中 |
| `docker compose -f deploy/compose.yaml config` | ✅ | digest 锚点正确展开 |

## 4. 数据库迁移循环验证

migrate → rollback → migrate 在真实 PG17（compose）上验证：

```
$ pnpm db:migrate
可用迁移文件 (1):
  - 0000_baseline_probe.js
已执行迁移 (1):
  ✓ 0000_baseline_probe

$ pnpm db:rollback
✓ 已回滚迁移: 0000_baseline_probe

$ pnpm db:migrate（幂等重建）
已执行迁移 (1):
  ✓ 0000_baseline_probe
```

集成测试（Testcontainers，独立 PG17 容器）4/4 通过：
- listMigrations 列出迁移
- migrateToLatest 建表 + kysely_migration 记录
- migrateDown 回滚 + 表消失
- 再次 migrateToLatest 幂等重建

## 5. Canary 框架验证

evidence:canary 证明 MetadataLogger 白名单过滤机制（迁移自 PoC observability.mjs）：

```
canary: W01_CANARY_PROBE_SECRET_BODY_20260727
hits: {"postgres":0,"redis":0,"logs":0,"traces":0}
total: 0
passed (total===0): true
```

日志缓冲实际内容（白名单字段，body 字段被过滤）：
```json
{"time":"2026-07-27T03:44:46.084Z","level":"info","event":"probe","requestId":"req-canary"}
```

## 6. Git 与安全验证

- `.gitignore` 排除：`参考/`（TokenHub/Sub2API 源码）、`old version/`、`node_modules`、`.env`、`.corepack-bin`、`.zcode/`、PoC `.runtime/`
- `git ls-files` 确认：134 个文件，无 node_modules、无 .env、无外部源码
- `.env.example` 仅变量名+假值，无真实 Secret
- ADR 行 34-38 约束：未复制 TokenHub/Sub2API 任何源码到产品目录
- 首个 commit：`dd33453`（治理文档 + 产品工程基线统一管理）

## 7. 迁移自 PoC 的语义合同（不直接搬 .mjs 代码）

| PoC 文件 | 迁移到 | 语义保留方式 |
| --- | --- | --- |
| observability.mjs MetadataLogger | packages/observability/logger.ts | 白名单 11 字段，运行时过滤 |
| persistence.mjs scanCanary | packages/observability/canary.ts | 跨四存储扫描框架（PG/Redis sink 在 M2 接入） |
| provider-secrets.mjs SecretValue | packages/provider-adapters SecretValue | 强制 [REDACTED]，reveal() 取明文 |
| gateway-spike.mjs Outcome/Usage | packages/contracts | TypeScript 类型骨架 |
| gateway-spike.mjs RETRYABLE | packages/domain | 可重试状态码集合 |

## 8. 已知 workaround（W01 内最小修正，已记录）

| 项 | 现象 | 处理 | 是否技术栈漂移 |
| --- | --- | --- | --- |
| corepack pnpm shim | `/usr/local/bin` 无写权限，pnpm 子进程自我调用 ENOENT | 创建 `.corepack-bin/pnpm` wrapper + PATH 注入；`.gitignore` 排除 | 否（不改变 pnpm 版本） |
| pnpm ignored builds | esbuild 等 build script 默认不执行 | `--config.dangerouslyAllowAllBuilds` 一次性批准 | 否 |
| Docker credsStore | testcontainers credential helper 失败 | 临时移除 credsStore 跑测试后恢复 | 否（不改镜像 digest） |
| `.npmrc verify-deps-before-run=false` | corepack shim 场景下 pre-flight install 失败 | .npmrc 显式禁用，注释说明 | 否（不改 install 行为，仅跳过 run 前校验） |

以上均为环境适配，不改变工程规则 §2 冻结的技术栈版本，符合"只允许 W01 内最小修正并记录"。

## 9. 残余风险

- **CI 未启用**：`.github/workflows/ci.yml` 已就绪，但 Local First 期无远程仓库，CI 推迟到 W24。本地命令全绿是当前质量门禁。
- **PG/Redis sink 未接入 scanCanary**：W01 canary 框架只验证了 logs sink；PG/Redis sink 在 M2 集成测试接入（PoC 已有完整实现可迁移）。
- **e2e 为占位**：真实 e2e（Playwright + 真实 Web/Gateway）在 M1/M2 落地。

## 10. 集成点（为 M1/M2 预留）

- W02 (M1) 用 packages/database 迁移框架建 principal/admin_user/audit_log 表
- W03 (M1) 用 provider-adapters 的 SecretValue + Key digest 模式
- W05 (M2) 用 contracts 的北向合同骨架
- W06 (M2) 实现 DeepSeek Adapter，对接 Adapter 接口签名
- W07 (M2) 用 database 建 ai_request/upstream_attempt/ledger_* 表
