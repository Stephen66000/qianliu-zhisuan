# 仟流智算 1.0 FR／WT 需求—交付—证据矩阵

| 字段 | 内容 |
| --- | --- |
| 需求基线 | PRD v0.3，FR-001～023、WT-01～20 |
| 实现候选 | `origin/main@7ec225b`＋1.0 封板修订；最终 Commit 待 R16 固化 |
| 数据库 | `0001～0044` |
| 当前状态 | `R05 COMPLETE / ENGINEERING PASS` |

状态口径：`DONE` 已有实现与测试／生产证据；`DONE_WITH_LIMITS` 在一期明确边界内完成；`PARTIAL` 有未闭合项；`DEFERRED` 明确不属于 1.0 完成结论。

## 1. FR 追踪矩阵

| FR | 交付结果 | 主要实现／证据 | 状态 |
| --- | --- | --- | --- |
| FR-001 单企业和管理员账号 | Session、同企业多管理员、密码生命周期 | `apps/control-api/src/admins/`、`apps/web/src/pages/Admins.tsx` | `DONE` |
| FR-002 员工／项目统一主体 | Principal 统一 EMPLOYEE／PROJECT，账本和授权复用 | principal repository／routes、迁移 0002 | `DONE` |
| FR-003 独立 Key 与限制 | Key 一次展示、摘要、白名单、额度、并发、撤销／重置 | principal auth、key routes、M6 撤权、POOL-029／040 | `DONE` |
| FR-004 Provider／Resource／Model Route | 三厂商、多资源、统一模型、Route 和发现／健康 | provider routes／adapters、迁移 0005／0036 | `DONE` |
| FR-005 API／套餐管理 | API 余额／费用、套餐购买／额度／周期与自动窗口 | Resources、quota window、POOL-032 | `DONE` |
| FR-006 模型和额度分配 | 单人接入配置＋批量授权，主体×厂商池 | POOL-029／033／035、迁移 0038～0041 | `DONE` |
| FR-007 额度规则模板 | API 单价、套餐倍率、星期／时间窗、版本化 | billing rule、QuotaRules、迁移 0011／0021 | `DONE` |
| FR-008 Gateway 协议与适配 | Models、Chat、Messages 原生；Responses 转换；其余显式拒绝 | contracts matrix、gateway routes、W05／POOL-002 | `DONE_WITH_LIMITS` |
| FR-009 Token 用量与路由账本 | 请求、候选、Attempt、usage、费用与质量可下钻 | gateway pipeline、usage routes、W07／POOL-043 | `DONE` |
| FR-010 分时价格和倍数 | 请求时点命中规则版本并保存价格／倍率证据 | billing rule、pricing evidence、POOL-001 | `DONE` |
| FR-011 套餐优先和 API 兜底 | 候选路由按模式／优先级调度，兜底需显式启用 | routing／dispatch policy、W12／W16 | `DONE` |
| FR-012 额度停止和超额 | 预占、停止、超额开关和异常展示 | quota gate、W14、首页超额 | `DONE` |
| FR-013 首页看板 | 本月指标、资源摘要、耗尽、超额和 API Token 摘要 | Dashboard、POOL-031／042 | `DONE` |
| FR-014 异常告警 | 异常中心、可用性事件、企微通知和人工恢复 | runtime-assurance、迁移 0030／0031 | `DONE` |
| FR-015 桌面 Web | React 桌面 Web，macOS／Win11 Chrome 证据 | M5 Evidence、Win11 11/11 | `DONE` |
| FR-016 默认正文零留存 | 业务表和日志不保存正文，canary 门禁 | observability canary、W07、R12 最终质量门禁 | `DONE_WITH_SCAN_BOUNDARY` |
| FR-017 Agent 入口预留 | 技术合同和扩展边界保留；一期无独立 Agent 产品功能 | PRD／TRD 边界 | `DONE_WITH_LIMITS` |
| FR-018 账号池、多因子路由与故障切换 | 生命周期、多因子评分、Affinity、熔断和有界切换 | domain routing、W11／W12、运行保障 | `DONE` |
| FR-019 Session Affinity 与流式边界 | SSE、提交边界、取消和 Affinity；WebSocket 显式拒绝 | gateway pipeline、W12、POOL-014 | `DONE_WITH_LIMITS` |
| FR-020 请求级审计与分层记账 | request ID、逐 Attempt 明细和唯一 settlement | migrations 0007～0009／0024／0044、POOL-043 | `DONE` |
| FR-021 持续供给与耗尽预测 | 1h／24h／7d 速度、耗尽／恢复／覆盖和可信度 | supply forecast、Dashboard、POOL-042 | `DONE` |
| FR-022 峰谷经营调度 | 版本化策略、受控动作、决策和可证明节省 | dispatch policy、W16 | `DONE` |
| FR-023 企业团队产品化 | 仅保留 enterprise 边界；团队、成本中心、RBAC、身份源未做 | PRD／TRD／M9 | `DEFERRED_TO_2.0` |

## 2. WT 真实任务矩阵

| WT | 任务 | 证据结论 | 状态 |
| --- | --- | --- | --- |
| WT-01 | 登记三厂商资源 | Resources＋三厂商生产资源记录 | `DONE` |
| WT-02 | 创建员工、Key、模型和额度 | 主体接入配置，POOL-033 统一编排 | `DONE` |
| WT-03 | 员工客户端首次调用 | WorkBuddy／ZCode／Codex 有证据；仟流 IDE 不在一期签字 | `PARTIAL_BY_SCOPE_CHANGE` |
| WT-04 | 创建项目并分配资源 | Principal PROJECT 与项目账 | `DONE` |
| WT-05 | 查看 Token、扣减和 API 费用 | 用量账本、员工账模型下钻 | `DONE` |
| WT-06 | 耗尽停止／允许超额 | quota gate 集成测试与首页超额 | `DONE` |
| WT-07 | 套餐资源切换／API 兜底 | 资源池故障注入与有界切换 | `DONE` |
| WT-08 | 首页发现资源／主体异常 | Dashboard＋运行保障＋POOL-031 | `DONE` |
| WT-09 | 停用主体／重置 Key | M6 下一次请求即时拒绝 | `DONE` |
| WT-10 | 查看路由候选和状态 | 额度规则＋请求路由下钻 | `DONE` |
| WT-11 | 多 Attempt 后单结算 | W07／W12／POOL-043 账本测试 | `DONE` |
| WT-12 | 流式提交后中断不拼接 | POOL-014 与 Gateway 流式测试 | `DONE` |
| WT-13 | Affinity 复用与故障切换 | W12 路由测试；正文不作为 Affinity 存储 | `DONE` |
| WT-14 | 未支持能力显式错误 | contracts matrix 与 unsupported routes | `DONE` |
| WT-15 | 供给速度、耗尽和可信度 | supply forecast 与首页资源摘要 | `DONE` |
| WT-16 | 高峰规则和受控动作 | W16 dispatch 集成测试 | `DONE` |
| WT-17 | 节省仅在有反事实时计算 | domain dispatch policy 测试 | `DONE` |
| WT-18 | 解释账号池评分 | route candidate／decision 下钻 | `DONE` |
| WT-19 | 凭证失效隔离与恢复 | W11 故障注入、运行保障；真实 OAuth 厂商签字不足 | `DONE_WITH_TEST_LIMIT` |
| WT-20 | 协议能力矩阵 | Responses 转换、Chat／Messages 原生、其余显式拒绝 | `DONE_WITH_LIMITS` |

## 3. R05 发现项关闭情况

| ID | 发现 | 影响 | 处理 |
| --- | --- | --- | --- |
| R05-F01 | WorkBuddy 教程旧 alias | 已改为生产 `ql-*`，关闭 | `CLOSED` |
| R05-F02 | M6 历史文档将 Responses 写为 UNSUPPORTED | Final 产品说明书明确为 TRANSFORMED；历史 Evidence 不改写 | `CLOSED` |
| R05-F03 | PRD／TRD 保留开发时“当前未决” | Final 产品说明书作为交付现状说明 | `CLOSED` |
| R05-F04 | FR-023、M8 不属于 1.0 已完成事实 | FR-023 进入 2.0；M8 保持业务 Evidence 不足 | `CLOSED_BY_SCOPE` |
| R05-F05 | 真实 OAuth 凭证恢复缺少最新生产签字 | 工程机制通过，真实厂商 OAuth 作为 2.0／业务运营验证项 | `CLOSED_WITH_LIMIT` |

## 4. 当前产品 Review 结论

23 项 FR 均有明确去向：1.0 范围内功能完成或按合同注明限制，FR-023 明确延期至 2.0。20 项 WT 均有实现与证据结论；WT-03 按客户端范围变更收口，WT-19 保留真实 OAuth 厂商签字边界。

R05 结论为 `ENGINEERING PASS`。完整自然月业务收口仍单独保持 `EVIDENCE_INSUFFICIENT`，不影响对已实现产品功能的工程判断。
