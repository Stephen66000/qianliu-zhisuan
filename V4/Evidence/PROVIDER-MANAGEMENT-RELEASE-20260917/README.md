# 厂商资源模块升级发布（2.5.3）

日期：2026-09-17。Tag：`v2.5.3`。最终提交：`0eaaebf`（分支 `codex/wecom-activation-release-20260911`）。

## 功能范围

- 厂商管理：新建（自定义代码 + Base URL + 主流厂商预设）、改名、安全删除（无资源/规则/事件引用时）
- 厂商资源安全删除：六类业务/财务事实前置拦截 + 全量派生配置级联清理 + unified_model 引用守卫
- 模型发现：Qwen 命名空间过滤、自定义 BaseUrl 解析、批量选择工具、探活限前 5 模型
- Coding Plan 总额度改选填；企业微信回调路径修正（caddy /api 前缀剥离对齐）
- Adapter 判定统一走持久化 `provider.adapter_type`（消除两处猜测逻辑不一致）

## 审核与整改

I1 级审核结论 PASS。审核报告全文（含 Findings、两轮整改记录、生产验证热修复记录）见同目录《仟流智算-I1审核报告-厂商资源模块-20260917.md》。

要点：

1. 初审 FAIL → 修复 lint 4 错、体量 3 超基线、删除级联 FK 500 路径（三张引用表），复审 PASS。
2. 交叉验证反馈 → adapter 判定统一、routes.ts 基线修正。
3. **生产验证发现 hotfix**（0eaaebf）：`provider_resource_operating_sync_attempt` 为 append-only 不可变表，级联 DELETE 撞触发器冒泡英文错误；改为前置拦截友好 409，并补真实 PG 回归测试。

## 质量门禁

typecheck / lint / build / 架构 / 体量 / audit:prod / duplication 全绿。测试：web 471、provider-adapters 302、domain 180、gateway pipeline 73、w04 集成 13（含 append-only 回归）、w09/w10 adapter 集成 13 全过。control-api 8 项、gateway pool043 2 项为 9-14 前既有失败（已在基线提交复现确认，非本次引入）。

## 发布记录

- 第一次部署：`/Users/stephen/releases/qianliu-provider-resource-fix-20260917-172034`（06f9a73，2.5.3），五服务健康；生产验证发现 append-only 热修复需求。
- 热修复 `0eaaebf` 推送后需重新部署生效。

## 产品语义备忘（删除边界）

- 配置可以后悔，事实不能抹掉：同步/发现模型不阻止删除；真实调用、账本、财务、订阅、账单确认、经营同步历史任一存在即永久禁止物理删除，只能停用/下架。
- 厂商须名下资源清空后方可删除；被运行保障规则/事件引用的厂商不可删除。

## 归档功能发布（2.5.4）

Tag：`v2.5.4`。功能提交：`712ee91`；发布脚本最终修复：`db6601e`（生产部署成功 Commit）。

- 背景：2.5.3 的「配置可删、事实不可删」语义下，已投入使用半年的厂商/资源永远无法物理删除，生产上无法清理误建或退休的厂商资源。
- 方案：引入「归档」生命周期——迁移 `0075_provider_resource_archive.js` 为 provider / provider_resource 增加 `archived_at` 列与索引；列表默认排除归档（详情查询、经营账单、计费路由等按 ID 访问的路径显式放行）；仓储提供归档/恢复（厂商须名下资源全部归档才可归档）；4 个 POST 接口带审计；网关 main 与 worker 两个 runner（coding-plan-quota、provider-operating-sync）查询排除归档；前端资源表格与厂商管理对话框提供归档/恢复按钮、归档徽标与「显示已归档资源」开关。
- 验证：w04 集成 14/14（新增归档全流程用例）、web 471、gateway pipeline 73、worker 3，全仓 typecheck/lint/build/架构/体量/audit 全绿；体量基线已在质量门禁 JSON 登记（routes.ts 542、ProviderManagementDialog 439、provider-repository 692）。

### 发布排障记录（三次部署）

1. 第一次（~18:14）：worker=unhealthy 回滚。根因：`migrate` 为一次性（run-once）服务，`docker compose up --no-deps` 不会重跑已退出的旧迁移容器，0075 从未执行，worker tick 查 `archived_at` 列报 503。修复：step 3.5 增加 `docker compose run --rm migrate` 显式执行迁移。
2. 第二次（~18:22）：仍 worker=unhealthy 回滚。日志显示迁移清单只有 75 个文件（止于 0074）。根因：migrate 使用独立镜像 `qianliu-zhisuan-migrate`，step 3 只构建 control-api/gateway/worker/web，migrate 镜像从未重建，`compose run` 复用旧镜像仍无 0075。修复（`db6601e`）：step 3.5 改为 `docker compose run --rm --build migrate`。
3. 第三次（18:25）：COMPLETE 部署成功。Release：`/Users/stephen/releases/qianliu-provider-resource-fix-20260917-182516`，Commit `db6601e`，五服务健康，回滚镜像备份 `qianliu-provider-resource-rollback-20260917-182516`。

## 模型恢复上架功能发布（2.5.5）

Tag：`v2.5.5`。提交：`8cac154`。

- 背景：2.5.3 的「一键下架清理」为单向操作——前端同步面板排除已下架模型，后端 `attachDiscoveredModels` 遇归档统一模型直接报错，已下架模型无任何恢复路径（生产验证中发现）。
- 方案：新增 `restoreResourceModelRoute` 仓储事务（恢复路由保持停用、统一模型恢复为 PENDING_CONFIG、模型回填资源 upstream_models）+ `POST /provider-resources/:id/routes/:routeId/restore` 接口带审计（重复恢复拦截 400）+ 前端已下架模型行「恢复上架」按钮与确认面板。**计价规则与员工授权不自动恢复**，恢复后模型处于「待配计价」，需重新配置后方可服务——符合「配置可重建、事实要留痕」原则。
- 验证：w04 集成 15/15（新增「下架→恢复→重复恢复拦截→审计留痕」全流程用例）、web 471、database 仓储 187、worker 94、gateway pipeline 73；全仓 typecheck / lint / build / 架构 / 体量 / audit / duplication 全绿；体量基线登记（routes.ts 576、hooks.ts 413、ResourceModelDiscovery 684、provider-repository 774）。
- 发布：`/Users/stephen/releases/qianliu-provider-resource-fix-20260918-132222`，Commit `8cac154`，五服务健康，回滚镜像备份 `qianliu-provider-resource-rollback-20260918-132222`。

## 路由启用入口补全（2.5.6）

Tag：`v2.5.6`。提交：`686c097`。

- 背景：生产验证恢复上架时发现「未启用」模型无启用入口——旧管理区（QuotaModelSection/QuotaRouteSection）在额度规则页改版中下线，启用统一模型/路由的 UI 路径整体缺失，属历史改版遗留缺口。
- 方案：同步面板「待配置 / 历史同步模型」区新增 `EnableRouteButton`，一键联动激活统一模型 + 启用路由，复用受审计 PATCH 接口（乐观锁 + 验证闸门）。纯前端变更。
- 验证：web 471 全过，typecheck / lint / build / 架构 / 体量 / audit 全绿；体量基线登记（hooks.ts 440、ResourceModelDiscovery 723）。
- 发布：`/Users/stephen/releases/qianliu-provider-resource-fix-20260918-135907`，Commit `686c097`，五服务健康，回滚镜像备份 `qianliu-provider-resource-rollback-20260918-135907`。
- 教训：UI 改版下线旧区块时，需盘点其中唯一操作入口是否有新落点，避免静默死路。

## 遗留事项

- P2-3：探活仅前 5 模型，UI 未区分「实测可用/推断可用」，列入后续迭代。
- P3：厂商预设双份维护（web 与 provider-adapters）、ResourceTable 空态文案、quota-sync 白名单报错文案、`resolveProviderModelsUrl` 未知厂商臆造域名回退。
- 既有失败用例（0072/0074 迁移基线断言漂移、pool043 结算断言）待统一修复。
