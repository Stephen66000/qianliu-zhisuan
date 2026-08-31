# 仟流智算 2.0 Stage 01／Gate 1 完成检查 Evidence

| 项目 | 内容 |
| --- | --- |
| 完成时间 | 2026-08-11 22:12（Asia/Shanghai）；PC-20260811-02 后重锁 |
| SOP | 仟流 AI 开发 SOP v1.0，Stage 01 方案准备 |
| 检查对象 | 2.0 标准版 Gate 1 Final.2 |
| 产品／技术版本 | PRD `v2.0-gate1.1`；TRD `v2.0-gate1.1` |
| 立项基线 | `v2.0-stage01-final.2` |
| 上游代码基线 | Annotated Tag `v1.0.0-final`；Commit `b3fb74b387ef61734d949be2e97fab7904bca959`；Tree `68719129f9e9ee6a0ebfa56ab371cc42912fb34c`；审核产品代码 `684b2d5f083282c3d90e703c427d044855036282` |
| 结论 | `done`；P0=0、P1=0、阻断性 Evidence Gap=0 |
| 外部客户 Evidence | 没有；按 Owner 决定不作为 Stage 01、Stage 02 或标准版工程交付前置 |
| 产品实现状态 | `todo`；本检查不授权编码、Git 写动作、发布或生产操作 |

## 1. 完成结论

Stage 01 已把“先做一套可交付标准版”冻结为唯一主线。PRD、TRD、立项基线、原型、角色权限矩阵、初始验收矩阵、六项 ADR 与四项关键 PoC 已形成一致合同；原型最新自动走查为 7/7 页面主任务、9/9 走查场景，四项 PoC 均为 `done / PASS_WITH_LIMITATIONS`，限制已写回方案和后续工作包。

PC-20260811-02 已回收全局自然人／实名核验扩张：2.0 只保留账号、realm、独立 Session、TOTP step-up、状态机、职责清单和审计等最小双控，并明确不技术证明未披露的同人多账号；判别式导出来源合同保留。该变化已同步到产品、技术、验收、权限、计划、ADR、原型与走查 Evidence。

客户访谈、三家客户确认、设计客户签字和真实客户数据均不存在，也不伪造。它们被放入交付后的独立业务验证轨，初始 `validation_status=todo`；没有客户只意味着商业假设尚未验证，不阻塞标准版工程推进。

## 2. 冻结范围

- 产品范围：企业开通、独立组织／团队／成本中心、1 平台＋7 企业角色、typed scope RBAC、成员生命周期、Principal Key 自助、预算与额度、归属与分摊、四态账期、经营 Statement、后置价值确认、固定分片导出、确定性耗尽估算和标准运维；
- 技术边界：一企业一部署且绑定不可变、全链 EnterpriseContext＋复合约束＋RLS、本地身份双 realm、Owner 双 share 恢复、支持访问双平面、账号级职责清单、Provider Secret 双角色、判别式导出来源、私有对象存储、迁移 identity epoch 和恢复包络；
- 非范围：共享 SaaS、OIDC／SSO、Agent、金额硬拒绝、自动采购／充值、请求正文留存和客户特有集成；
- 客户验证：工程交付后、真实条件具备时再启动，不进入当前交付 DoD。

## 3. 候选锁

候选文件及 SHA-256 见 [candidate-manifest.sha256](./candidate-manifest.sha256)。清单冻结 Stage 01 权威产品／技术合同、原型、验收、ADR、PoC 结果和进度事实；开发规划在 Stage 02 会继续形成正式权威版本，因此不纳入 Stage 01 不变候选锁。

任何会改变目标、范围、非目标、关键安全边界、验收或交付退出条件的修改，必须登记 [Planning Change Log](../../../Planning-Change-Log.md) 并按影响范围返回；不得静默改写本结论。

## 4. 检查结果

完整命令和输出摘要见 [checks.txt](./checks.txt)，机器可读结论见 [result.json](./result.json)。本轮确认：

- 最新原型 Playwright 自动走查 7/7 页面主任务、9/9 走查场景通过；
- Markdown 本地文件链接、HTML 内联脚本、JSON、Shell 和 CJS 语法检查通过；
- Stage 01 `STAGE_DATA` 共 38 项，38 项均为 `done` 且绑定存在的 Evidence；
- 四项 PoC 结果 JSON 有效，结论均为 `PASS_WITH_LIMITATIONS`；
- 受限 Gate 1 合同复审结论 P0=0、P1=0；旧身份治理字段 0 命中，生命周期、支持、Owner 恢复和销毁的最小双控口径一致，关键 AT 的集成归属闭合；
- 没有把实现型 `todo`、客户验证 `todo` 或 Stretch Goal 冒充已完成。

## 5. 未覆盖与残余风险

- 本 Evidence 不证明 2.0 产品代码、正式迁移、跨企业隔离、容量、恢复、真实导出或目标环境已经实现；
- POC20-001～004 的正式实现、同候选复验和目标环境门禁仍由开发规划 W20 工作包完成；
- 标准版无法技术识别未披露的同人多账号；交付职责清单是管理控制而非实名证明，统一身份／SSO 合同留待 2.1；
- 客户价值、付费意愿和自然月效果没有 Evidence，后续只能记录“达标／未达标／证据不足”；
- 工作树存在用户既有改动和未跟踪文件，本轮未清理、暂存、提交或改写其归属。

## 6. 唯一下一动作

进入 Stage 02，只把冻结方案转化为三份权威成果：整体开发计划、项目工程规则和开发执行基线，并形成 Stage 02 进度／完成检查 Evidence。Stage 02 完成前不开发产品代码；即使 Stage 02 完成，创建 worktree／分支、commit、push、PR、merge、Tag、发布和生产动作仍需分别获得明确授权。
