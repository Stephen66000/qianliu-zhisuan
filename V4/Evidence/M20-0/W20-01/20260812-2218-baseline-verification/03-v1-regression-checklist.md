# FR2-001／AT-001 可执行回归清单

状态：`done`。合同来自当前 `6fc1bec2…` 实现、冻结计划 §2 与 AT-001 的交集；`PC-20260812-04` 已登记并生效。代表性 Fixture 直接绑定既有受保护 E2E seed；YAML 只补充 oracle，不重写夹具。

| ID | 区域／入口 | 当前 1.0 必锁行为 | 现有主要自动化 | 补充特征测试／验收动作 | 当前状态 |
| --- | --- | --- | --- | --- | --- |
| R01 | 认证＋10 个主导航 | Cookie Session、ACTIVE 管理员、首次强制改密、401；10 个导航 direct URL／刷新；旧 `/alerts` 跳转 | `w02-auth-principal`、`pool015`、Playwright 登录 | 锁 10 个链接、直接 URL、刷新、401、旧链接和强制改密 | pass |
| R02 | `/dashboard` | **当前实现**八项卡、可选“需要处理”、资源摘要 14 列及模型原地下钻、本月真实 Token＋员工排行；缓存／推理为子集，未知不伪造 0 | `Dashboard.test.tsx`、`ResourceBreakdown.pool042`、`w18-dashboard-usage`、E2E POOL-042 | 锁字段／顺序／非零 reasoning 守恒；PC-04 冻结 2.0 六项主卡与旧字段稳定落点 | pass |
| R03 | `/principals` | 新建、编辑、停启用、清理／归档；Key 明文一次；厂商池、型号开关、白名单、Grant 原子生效；历史可追溯 | `Principals.test.tsx`、`w02/w03/pool033`、E2E WT-02/03/04/09、POOL-009 | 同一 Fixture 锁停用→启用不恢复旧授权、归档后用量可追溯、接入配置三段完整字段 | pass |
| R04 | `/employee-model-rules` | DRAFT→VALIDATED→PUBLISHED→DISABLED；版本、幂等、SET／ADD；发布原子更新 Key＋Grant | `EmployeeModelRules.test.tsx`、`pool029`、E2E POOL-029 | 发布前后 Key／Grant／手工授权集合 golden | pass |
| R05 | `/resources` | 登记／编辑资源；API 与 Plan 严格分栏；DeepSeek／Kimi／智谱；额度窗口、预测、健康、恢复；未知／STALE 诚实展示；凭证不回显 | `Resources.test.tsx`、`pool010/pool027`、Gateway `w09/w10/w11/w15`、多项 E2E | 锁 9 列、三厂商、API／Plan、5h＋周窗口、STALE／UNSUPPORTED、恢复前后状态 | pass |
| R06 | `/quota-rules` | 统一模型、Route、计价、调度各自生命周期；经济字段不原地改历史；请求时点版本快照 | `QuotaRules.test.tsx`、`w19`、Gateway `w13/w16/w18`、E2E WT-10/22 | 四类对象分别做状态机表驱动与历史版本断言 | pass |
| R07 | `/usage`＋请求下钻 | 筛选／搜索／分页／URL 恢复；request→candidate→Attempt→Usage／Ledger→Settlement；真实消耗 Attempt 独立明细；UNKNOWN/null 不冒充 0 | `Usage.test.tsx`、`w18/w20`、Gateway `w07/w08/w12/pool043`、E2E WT-05/11/12/13/16/17、POOL-012 | 锁 project/date/client 组合、真实翻页、四类 Token 与费用守恒 | pass |
| R08 | `/operating-bill*` | 月度总览、员工账、项目账、快照导入、价值项、归属、DRAFT/CLOSED、重开新版本；旧版本不可改；员工厂商筛选／搜索 | `OperatingBill*.test.tsx`、`pool025/pool043`、Gateway settlement、E2E POOL-025/043 | CSV、CLOSED v1→重开→CLOSED v2、旧版稳定、企业／员工／项目／厂商同 Fixture 守恒 | pass |
| R09 | `/runtime-assurance?tab=*` | 五区：运行态势／资源健康事实、规则、事件、异常、通知与人员；规则版本、恢复、处置、掩码 Secret、发送记录 | `RuntimeAssurance.test.tsx`、Control／Worker／Gateway integration、E2E RA-WT-18 | 五区 direct URL、加载空错态、规则生命周期、事件恢复、异常处置、Secret 轮换 | pass |
| R10 | `/admins`、`/change-password`、`/settings` | 新增／改名／停启用、本人改密、他人重置、首次密码；操作日志六列；升级日志筛选／详情／终态不可改 | `Admins/ChangePassword/Settings.test.tsx`、`pool015/pool026`、E2E POOL-015 | 管理动作 Web 闭环、操作日志过滤和审计、升级日志分页／时间／敏感 Manifest 负向 | pass |
| R11 | Gateway 公共协议与账本不变量 | `/v1/models`、Chat／Messages／Responses；不支持协议稳定 422；授权／Route／价格／策略快照；预占结算；提交后不切换；正文零留存；API／Plan 隔离 | Gateway `w05～w18`、`pool043`、`m6-key-revocation`、Codex CLI E2E | 固定客户端形状、请求证据链；日志 canary 已执行，DB／Redis／Trace 全域扫描不适用于本次纯测试差异 | pass |

## 执行判定

- 每项使用 `fixture-contract.yaml` 绑定的 E2E seed、固定 ID 和期望值；缺少的数据只按具体特征测试最小补充，不使用原型示例数冒充事实。
- 页面可换布局，但入口、字段、操作、URL 和证据下钻不能减少。
- 任一候选文件、迁移、依赖锁或 Fixture 改变，更新 candidate lock 并按影响范围重跑。
- `PC-20260812-04` 已将当前 1.0 八项事实与 2.0 六项主卡拆开；日／周／月仍属于 FR2-003，不冒充 W20-01 已实现能力。
- 本次最终门禁覆盖 136 files／1009 tests、Web Playwright 28／28 与固定 Codex CLI 0.146.0 Gateway E2E；细节见 `05-test-execution.md`。
