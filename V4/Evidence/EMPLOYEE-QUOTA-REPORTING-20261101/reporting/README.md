# Worker 报表一致性与月额度接入：本地工程证据

状态：本地开发完成；未 commit/push、未迁移生产、未部署、未发送或重发消息、未历史补扣。套餐额度只读核验 ordinaryUsageAllowed=true 后执行。所有 PNG、SVG、TXT 与 preflight JSON 均为隔离 PG 或手工合成夹具，不能作为真实生产用量、上线或业务收到证明。

## 实现

- `report-facts.ts` 一次 repeatable-read + READ ONLY 读取 Overview、员工模型与额度；图文消费这份冻结事实，并在投递快照保留 factVersion、生成时点、员工范围、时区、额度业务截止与来源。
- 日报/周报/月报均显式员工范围与企业时区。Top3 分母取完整员工用量，真实模型总数独立；Flash 与非 Flash 两行保持各自身份。周报额度按期末最后一刻所属月读取，删除 UTC 拼月界及两种余额减法。
- 额度按厂商和 raw/套餐单位分列。旧月不凭今天授权造月账，无法证明余额则待核；未结清显示预占与暂定。新月账从月账自身读取超额策略，UNKNOWN 不输出确定历史策略。Legacy counter 只在切换预检列为历史来源，不再用于报告余额。
- Worker 使用与请求/查询相同的 `initializeCurrentQuotaPeriods`，重复 tick 只确保当前月账；B 段表未迁移时初始化 no-op、报表保守 legacy，保持 A 段兼容。
- 旧 deliverReport、schedule、recipient、SENT identity、UNKNOWN 防重未改变；没有消息工具调用。月初始化错误单独记错，不阻断原聚合任务。

## 预览

- `synthetic-seven-member-three-provider.png`：1080 宽、7 成员、长姓名/团队、Flash/非 Flash 两行、4 模型展示 Top3、三厂商、raw/套餐、超额和待核。对应 SVG 是可检视结构。
- `synthetic-long-name-personal.png`：1080 宽、长姓名、厂商额度数值按语义分行；没有数字/单位拆断或底栏覆盖。
- `synthetic-company-weekly.*`、`synthetic-personal-weekly.*`：隔离 PG 中旧周期待核和跨月周报。
- `synthetic-monthly-quota-{company,personal}.{png,svg,txt}`：隔离 PG 中月账 raw 超额、套餐可用、UNKNOWN 保守预占；团队/个人及图文同源。
- 已实际打开并逐图检查主团队和个人图，修复摘要串列、长模型碰数值、个人数值被硬拆行；采用必要增高；表格为 10.5px（导出 21px），个人数值 14px（导出约 34px）；额度摘要状态为 16px（导出 32px），状态过长分行，不进一步缩字。

## 验证

- reporting 目录：16 个测试文件、108 个测试全部通过，`--maxWorkers=1 --minWorkers=1`。含真实 PG、Redis、并发/重复/SENT/UNKNOWN、数据保留回滚后重放、日报项目隔离、月界、模型、个人接收人和模板。
- 最后增量回归：facts / preflight / scheduler-loop / scheduled-tasks，4 文件 20 测试全部通过，workers=1。
- Worker typecheck / lint / build 通过；日志见本目录。初轮失败为未预热 Redis 镜像及新 0092 数据保留 down 后 up 重放冲突；固定镜像预热和 DB 幂等 up 修复后，全报告回归已通过。
- T10—T20、T23 的工程层覆盖在上述测试；T02 Worker 重复初始化、legacy 不提前初始化；T24/1.2/6.3 为只读预检。真实窗口/实际送达/首个完整新月业务验收仍待授权发布后的证据，不能以这些合成图替代。

## 只读 CLI

```sh
corepack pnpm@11.11.0 --filter @qianliu/worker exec tsx src/main.ts quota-reconcile preview --enterprise <id> --principals <employee-principal-id,...> --from <ISO-with-timezone> --to <ISO-with-timezone>
corepack pnpm@11.11.0 --filter @qianliu/worker exec tsx src/main.ts quota-reconcile preflight --enterprise <id> --month <YYYY-MM>
```

两者均 repeatable-read + READ ONLY，拒绝 --execute/--apply。历史 preview 复用 DB 证据预览接口，无法证明历史 grant/version 的消费为 UNKNOWN、原/目标/差额为 null；不改财务与旧账。

切换 preflight 输出拟生效自然月、最早未来完整月、现有 activation、当前员工池 basis/allowOverage、legacy 周期/计数及已授权可用路线模式。复用现有 catalog readiness，再过滤有效 Key 型号白名单及显式禁用；混合 API/套餐、缺 basis、不匹配、无授权就绪路线、非池旧授权、已过月界或 activation 冲突均 NO_GO。它只验证当前配置，未访问模型或替代发布时重新预检。`synthetic-switch-preflight-{go,no-go}.json` 是可审阅示例；实际生产预检尚未执行。
