# RA-W08 本地发布候选 Evidence

- 时间：2026-08-01 08:49 Asia/Shanghai
- 范围：Local First 的 RA-W02～RA-W08 开发、迁移回归、全量质量门禁和临时本地 Chromium E2E。没有部署 Mac Mini，没有 Git 提交／分支／合并，没有触碰生产数据。

## 命令与结果

- `pnpm -r run typecheck`：PASS（11 个工作区）。
- `pnpm -r run lint`：PASS，0 warning。
- `pnpm -r run test`：PASS；Contracts 3、Config 5、Domain 134、Web 53、Observability 4、Provider Adapter 65、Database 23、Worker 4、Control API 77、Gateway 109。
- `pnpm -r run test:integration`：PASS；Provider 3、Database 21、Control API 77、Gateway 106。Worker 修正独立脚本后 4/4 PASS。
- `pnpm -r run build`：PASS。
- `pnpm --filter @qianliu/web run test:e2e`：临时本机 PostgreSQL 17、专用 `qianliu_e2e`、Chromium 22/22 PASS；容器执行后已删除。
- 迁移链：RA-W01 已验证空库升级、`0030` 回滚、重升和 Schema 指纹一致；本轮全量 Database 回归再次 PASS。
- 文档：PRD 一期／非目标边界、TRD、正式开发计划与 `stage-state` 已按实际结果同步，两份进度 HTML 从 YAML 重新生成。

## 原始结果摘要哈希

- typecheck: `0eb18f28d241ad16fcbc437a0da868ac66fb462d564b680a76082c4bf48454a9`
- lint: `5ccfcdb8954b962284ef82a1492970e3c67d4ff5f1cd0e0d0af5cb0ef44862f3`
- test: `ae3b697364df4b5cfa7610454784be97b60dec0ca25d0f715d87177eb82ec0b9`
- integration: `9821d4a379d12be675a8fe8a6856ef5245da878189e07fd8d486ef86c4137b94`
- build: `d0858e12fbcdb020d142c4fcab860e47a3bdae4df6610f283700a9a27657d859`
- Chromium 最终 22/22: `e898aa5026551050b6c39104fd625d9837201a6ea3baa706fcb3e59392dc15e4`。
- Web 截图: `e9e6bd5f8274315bfbb79ae461e6965b053e87d4da9a5461c43535ab6ab8d44c`。

## Secret 与边界扫描

- 全量门禁日志中，定向 Secret/token canary 命中 0。
- 最终六项门禁统一使用项目锁定的 Node `22.17.1` 执行，无 engine warning。
- 新运行保障 Schema 无 `tenant_id` / `enterprise_id`；扫描命中的 `enterprise_id` 仅来自既有 `provider_resource` 和 `alert_event` 企业边界。
- 企微发送仅官方 API Host 和内部成员 `userid`；没有群或机器人 Webhook 实现。

## 风险与结论

- 本地开发质量门禁：PASS。
- Web 生产构建仍有 Vite 主 chunk `504.64 kB` 的非阻断性体积提示；本次新增一级模块功能、类型和 E2E 均通过，拆包优化不在运行保障业务范围内。
- 真实 Kimi／智谱信号、WorkBuddy／Claude Code／ZCode 中文展示、企微真实成员到达、Mac Mini 备份／迁移／回滚／部署和生产只读核验：`PENDING_EXTERNAL_OWNER_AUTHORIZATION`。
- 因冻结口径明确禁止当前部署 Mac Mini，RA-W08 状态为 `LOCAL_GATES_PASS / EXTERNAL_GATES_PENDING`，不伪报整体生产完成。
