# W20 E2E 运行说明（Playwright WT-01~20 Web 路径）

## 前置（宿主机一次性）

1. **修复 corepack**（W18 起已知故障）：`corepack prepare pnpm@11.11.0 --activate`
2. **启动 Postgres**（Docker）：`docker run -d -p 5432:5432 -e POSTGRES_PASSWORD=qianliu postgres:17-alpine`
3. **迁移 + 种子管理员**：

   ```bash
   export PATH="$PWD/.corepack-bin:$PATH"
   pnpm db:migrate
   # 创建企业 + 管理员（admin / admin123，或用 E2E_ADMIN_* 覆盖）
   pnpm --filter @qianliu/control-api exec tsx scripts/seed-admin.ts  # 见下
   ```

4. **安装浏览器**：`pnpm --filter @qianliu/web exec playwright install chromium`

## 运行

```bash
export PATH="$PWD/.corepack-bin:$PATH"
pnpm --filter @qianliu/web test:e2e
```

Playwright `webServer` 会自动拉起 control-api（8788）与 web dev（5173）。

## 覆盖映射（WT-01~20）

| 分类 | WT | 覆盖方式 |
| --- | --- | --- |
| **Web 路径（本套件）** | WT-01/02/05/08/09/10/15 + 告警/操作日志/七入口/主题 | `e2e/wt-web.spec.ts` |
| **网关运行时（非 Web 路径）** | WT-03/04/06/07/11/12/13/14/16/17/18/19/20 | 后端集成测试 `apps/control-api/src/__tests-integration__/`（w02-w20）+ domain 单测 |

## 双浏览器回归（M5 DoD）

- macOS Chrome：本套件（chromium project）。
- Win11 Chrome：佳哥本地实机执行同一命令（`test:e2e`），或登记为待验。

## 注意

- E2E 依赖真实 API + 真实库（DoD：模拟数据不进试点库）；E2E 创建的对象用时间戳后缀幂等命名。
- 本沙箱无 Docker/浏览器，套件未在此执行；宿主机首次运行如遇失败，按 `trace`（`playwright show-report`）定位。
