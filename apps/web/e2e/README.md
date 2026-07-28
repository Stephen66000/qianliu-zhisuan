# M5 Playwright 真实 API E2E

本套件每次运行都由 `global-setup.ts` 调用 `seed:e2e`，在独立数据库重建固定夹具：
Provider、资源、主体、Key、Grant、请求、路由候选、Attempt、usage_event、ledger_line、
ledger_transaction、计价规则、预测、调度策略/决策和告警。测试库与试点库物理隔离。

## 安全前置

`seed:e2e` 只接受：

- 主机为 `127.0.0.1` 或 `localhost`；
- 数据库名以 `_e2e` 结尾。

不满足任一条件会立即拒绝写入。夹具会清空该专用 E2E 库的业务表，严禁把
`DATABASE_URL` 指向试点、共享或生产库。

## macOS

```bash
export PATH="$PWD/.corepack-bin:$PATH"
export DATABASE_URL="postgres://postgres:qianliu@127.0.0.1:55432/qianliu_e2e"
export GATEWAY_KEY_PEPPER="m5-e2e-only-pepper"
export CREDENTIAL_KEK="ZGV2LW9ubHkta2VrLXJlcGxhY2UtaW4tcGlsb3QAAAA="
export COOKIE_SECRET="m5-e2e-cookie-secret-at-least-32-bytes"
pnpm --filter @qianliu/web test:e2e
```

## Windows 11 PowerShell

```powershell
$env:PATH="$PWD\.corepack-bin;$env:PATH"
$env:DATABASE_URL="postgres://postgres:qianliu@127.0.0.1:55432/qianliu_e2e"
$env:GATEWAY_KEY_PEPPER="m5-e2e-only-pepper"
$env:CREDENTIAL_KEK="ZGV2LW9ubHkta2VrLXJlcGxhY2UtaW4tcGlsb3QAAAA="
$env:COOKIE_SECRET="m5-e2e-cookie-secret-at-least-32-bytes"
pnpm --filter @qianliu/web test:e2e
```

首次运行前需创建 `qianliu_e2e` 数据库并安装 Chromium：

```bash
pnpm --filter @qianliu/web exec playwright install chromium
```

## WT 映射

| WT | Web 断言 |
| --- | --- |
| WT-01 | 创建 Provider、登记资源、凭证不回显/不出 API |
| WT-02/03 | 员工→Key 一次展示→Grant→接入信息 |
| WT-04 | 项目按相同顺序开通 |
| WT-05/11 | 请求汇总与两 Attempt 两条账本明细一致 |
| WT-06 | 允许超额关闭/开启及 version 副作用 |
| WT-07/14 | 隔离/健康资源与 Provider 协议能力定位 |
| WT-08 | 首页发现异常、告警处置、operation_log |
| WT-09 | Key 重置、旧 Key 撤销、新明文不再回显 |
| WT-10 | 计价规则、统一模型、Model Route 创建/编辑 |
| WT-12 | 流式提交后中断只有一个 Attempt |
| WT-13/18 | 路由评分因子、Affinity 与正文零留存 |
| WT-15 | 速度、耗尽、恢复、覆盖、可信度 |
| WT-16/17 | 调度输入/策略/动作/反事实/节省 |
| WT-19 | 隔离资源二次确认受控恢复 |
| WT-20 | 七入口与协议相关管理配置全部可达 |

套件没有 `if visible`、空态二选一或 catch 后跳过。每个写用例同时验证 HTTP/数据库可见
副作用，每个读用例同时验证 API 事实与页面结果。
