# 仟流智算 2.0 标准版原型走查 Evidence

| 项目 | 内容 |
| --- | --- |
| 日期 | 2026-08-11（Asia/Shanghai） |
| 对象 | `V4/原型/仟流智算-2.0-标准版原型.html` |
| 原型版本 | Stage 01 标准版原型 v1.8（判别式导出来源、最小账号级双控和职责清单残余风险写回） |
| 数据 | 内部合成 Fixture；非客户、非生产数据 |
| 走查状态 | `done` |
| 产品实现状态 | `todo`；原型走查不等于功能实现或验收通过 |
| 执行人 | 当前 Codex 任务 |

## 1. 走查目标

确认标准版产品主线能够从真实用户入口完成以下任务，并明确展示失败、拒绝、取消和恢复结果：

1. 开通企业；
2. 导入组织、停用成员并撤权；
3. 分配组织作用域角色；
4. 恢复失效厂商资源；
5. 发布预算并触发告警；
6. 经历账期检查失败、处理、重新检查、结账和重开；
7. 申请、审批、撤销支持访问；
8. 走查企业归档、保留、销毁和备份退役影响。

## 2. 环境与输入

- Python `3.10.20`；
- Playwright `1.38.0`；
- Google Chrome `151.0.7922.108`；
- 桌面视口：`1440 × 960`；
- 移动视口：`390 × 844`；
- 本地静态 HTTP 服务；
- 未连接 Control API、Gateway、PostgreSQL、Redis、生产数据或外部网络服务。

## 3. 可复现命令

在仓库根目录开启本地静态服务：

```bash
python -m http.server 9876 --bind 127.0.0.1 --directory "V4/原型"
```

另一个终端执行：

```bash
python V4/Evidence/Stage01/20260811-standard-prototype-walkthrough/prototype_walkthrough.py
```

预期输出：

```text
Prototype walkthrough OK: 7/7 page tasks, 9/9 walkthrough scenarios, dual-role-secret, owner-dual-share, typed-scope-period-resolution, post-close-value, export-realm-split, failure/recovery-only, support-actor-reject-reapply, bootstrap-invite, reopen, mobile layout
```

## 4. 结果

| WT | 场景 | 预期 | 实际 | 结论 |
| --- | --- | --- | --- | --- |
| WT-01 | 标准企业开通 | 显示创建影响、首位 Owner 无外部服务邀请路径、合成数据边界和幂等语义 | 对话框明确 invitation URL／code 只展示一次、经批准外部渠道交付且不依赖 SMTP／短信；任务进度 1/7 | `done` |
| WT-02 | 成员离职 | 登录、Key、模型、角色全部撤销，历史归属不变 | 状态变为“已停用”，恢复提示和审计生成 | `done` |
| WT-03 | 作用域授权与身份恢复边界 | 展示人员、角色、企业、范围、分摊职责分离和 Owner 双 share 恢复边界 | 确认后生成角色版本更新审计；原型明确 Owner 无 `allocation:manage`、AI 管理员无任何 `allocation:*`、同人不能自建自批；所有 Owner 目标要求不同平台账号 A/B 各自 step-up，A 只以 request 权限在创建响应取得 share A 且待批期不可消费，B 以独立 approve 权限在批准响应取得 share B，或以独立 reject 权限原子拒绝；创建账号不能自批／自拒，拒绝／过期使 A 失效且不产生 B，旧单不可重放；两份独立≥256-bit CSPRNG share 各显示一次，只存用途绑定 HMAC-SHA-256、不暂存 A 明文，并由双份原子消费与共享限速保护；职责清单声明 A/B 与目标 Owner 持有人互不重叠，并明确这不是技术实名证明 | `done` |
| WT-04 | 资源凭证过期 | 先阻断上游；AI 管理员 step-up 发起，另一名 Owner 独立 step-up 并单次批准后才激活、复检 | `凭证过期→待 Owner 确认→可用`；请求固定 24 小时、批准不续期；Owner 只见脱敏元数据，批准单次消费，明确未越权切换 | `done` |
| WT-05 | 预算告警 | 触发通知，不改写事实，不擅自金额硬拒绝 | 告警提示、负责人通知和 v4 规则审计可见 | `done` |
| WT-06 | 账期失败、typed-scope 处理、后置价值、受控导出与恢复 | 首次检查失败回 DRAFT；三类范围负责人各自处理 TEAM／COST_CENTER／PROJECT item，Owner 重检后 CHECKING→CLOSED；成本 Hash 冻结后再完成范围／Owner 价值确认；创建受控导出；可 REOPENED | 四态按合同转换；`period_check_item:resolve` 只在精确 typed scope 追加 resolution，越 scope 拒绝，不改基础 Token／费用／账本且未重检不能 Close；价值缺失不阻断 Close，确认前后 Statement Hash 不变；导出创建／每片 token 签发要求 10 分钟 step-up，不下发对象 URL；判别式 `EXPORT_MANIFEST_V1` 固定 `export_kind=source.kind`，`OPERATING_STATEMENT` 与 `OFFBOARDING_FINAL` 来源字段互斥完整，`source_fingerprint=SHA-256(RFC 8785 JCS(source))`，token 绑定 kind＋来源指纹；`SHA-256`、默认 8 MiB 固定分片、`file_sha256/chunk_sha256`、任意 Range 拒绝可见；一般账单只跨同一操作人的新普通 Session＋step-up，`RECOVERY_ONLY` 只续传当前 OFFBOARDING 已冻结最终导出且交叉访问拒绝；Control API 每 1 秒或 1 MiB 重验并可中止；重开后旧价值仍绑定旧 Statement | `done` |
| WT-07 | 支持访问 | 唯一平台支持账号 A 为本人账号申请；Owner 明确看到 `support_actor_id`；首次申请拒绝后 use 失败且旧单不可重用；重新申请，批准后限时最小权限，可立即撤销 | `申请 #1 待审批→已拒绝→申请 #2 待审批→30 分钟有效→已撤销` 全链可见；申请固定 24 小时，裁决前机会式过期、批准不续期且到期竞争只落一个终态；平台账号无批准权限，仅企业 Owner 可在企业 realm＋step-up 裁决；批准绑定 A、不可换账号、会话从批准时点起算且首次激活不续时；职责清单声明持有人不重叠，同时明确标准版不做实名同人识别 | `done` |
| WT-08 | 企业归档 | 展示停用、`RECOVERY_ONLY`、最终导出确认顺序、归档、保留、待销毁和销毁影响，不真实删除 | 普通 Session／Key 撤销、Owner 密码＋TOTP 换取 10 分钟恢复会话、业务 API／一般导出拒绝、Owner 从企业 realm 确认并发起后由平台账号从平台 realm 执行均可见；职责清单声明执行账号持有人不兼任企业 Owner，并明确不是技术实名证明；无删除动作 | `done` |
| WT-09 | 移动布局 | 关键页面可见且页面无横向溢出 | 390px 视口检查通过 | `done` |

## 5. 异常与恢复结论

- 账期检查失败没有产生 `CHECKING_FAILED` 第五种状态；
- 失败检查回到 `DRAFT`；TEAM／COST_CENTER／PROJECT 三类负责人只以 `period_check_item:resolve` 处理当前 typed scope，先由权威业务 API 形成修正版本，再 append-only 追加 resolution，不覆盖检查项或基础 Token／费用／账本；越 scope 稳定拒绝，Owner 必须重跑 Check 后才可 Close；
- 凭证过期先阻断资源；只有 AI 管理员发起＋另一名 Owner 独立批准并单次消费后，恢复资源才重新进入候选路由；
- 成员停用是登录、Key、模型和角色的完整撤权动作；
- 支持访问未审批、已拒绝、过期或撤销后均应拒绝；请求固定 24 小时且批准不续期，裁决前机会式过期并保证到期／批准竞争单终态；批准绑定唯一 `support_actor_id`，换账号必须重申请；仅企业 Owner 可在企业 realm＋step-up 裁决，平台账号无批准权限；职责清单声明持有人不重叠，但标准版不做实名／跨 realm 同人去重；拒绝单不可重用，批准 TTL 默认 30／上限 60 分钟，从批准时点起算且首次激活不续期；
- 高风险操作展示 TOTP step-up、影响说明和取消入口；
- 成本 Statement 先冻结，业务价值后置追加独立版本；价值缺失不阻断 Close，确认不改 Statement Hash，重开不自动继承旧价值；
- 完整导出创建与每个固定分片 token 签发均要求当前 10 分钟 step-up；不可变 `EXPORT_MANIFEST_V1` 使用判别式 `export_kind/source`，Statement 与退租来源字段互斥完整，`source_fingerprint=SHA-256(RFC 8785 JCS(source))`；固定 `hash_algorithm=SHA-256`、整文件 `file_sha256`／长度、默认 8 MiB 分片边界与每片 `chunk_sha256`，任意 Range 拒绝；一般账单只允许同一操作人跨新普通 Session＋step-up 续传，`RECOVERY_ONLY` 仅允许冻结资格 Owner 续传当前 OFFBOARDING 已冻结最终导出，两类导出按 kind＋来源指纹交叉访问拒绝；客户端无对象 URL，受控流按 1 秒／1 MiB 持续重验并在撤权或 Session 失效后中止；
- 分摊按范围负责人 manage、Owner read／approve、财务 read 分权；Owner 不具备 manage，同一自然人即使角色叠加也不得批准自己创建或最后修改的版本；
- 所有 Owner 凭证恢复由不同平台账号 A/B 各自以 10 分钟 step-up 和独立 request／approve／reject 权限处理；A 只在创建成功响应取得 share A 且待批期不可消费，B 只在批准成功响应取得 share B，或原子拒绝并使 A 失效且不产生 B；创建账号自批／自拒和拒绝／过期后的旧单重放均拒绝。每份至少 256-bit CSPRNG、只显示一次，只保存用途绑定 HMAC-SHA-256且不暂存／回显 A 明文，双份原子消费并共享限速；职责清单声明 A/B 与目标 Owner 持有人互不重叠，但不冒充技术实名证明；平台 peer 重置禁止；
- 多层金额预算只告警，既有 Principal Token 额度单独执行原子硬控制；
- 确定性耗尽估算按金额／额度分单位，过期或不可计算时不输出新日期；Forecast Worker 不直接修改配置／策略，1.0 已发布策略的兼容消费边界已在原型说明中明确；
- 企业停用后普通 Session／Key 撤销；冻结 Owner 只能用密码＋TOTP 获取最长 10 分钟 `RECOVERY_ONLY`，业务 API／一般导出拒绝；恢复只走冻结安全回边，Owner 从企业 realm 确认并发起后由平台账号从平台 realm 执行；职责清单声明两项持有人不重叠但不冒充技术实名证明；最终导出确认先于归档，`ERASED` 永不可逆；
- 企业销毁只完成影响走查，没有执行任何真实删除。

## 6. 未覆盖范围

- 原型不证明数据库约束、跨企业隔离、迁移、结账并发、容量或恢复能力；
- 原型不证明 WorkBuddy、Codex、ZCode 的 2.0 实际接入；
- 原型不证明客户需求、付费意愿或商业结果；
- 原型没有生产发布、Secret 注入、真实导出或数据销毁；
- 上述内容分别由关键 PoC、Stage 02 测试合同、Stage 03 实现 Evidence 和交付后业务验证覆盖。

## 7. Findings

本轮原型走查未发现阻断产品主流程的 P0/P1。

四项关键 PoC 均已形成 `done / PASS_WITH_LIMITATIONS` 结论并写回原型，原型明确区分“PoC 限制通过”和“产品实现完成”。本 Evidence 已在 `DEC-002～010` 冻结后重跑；Stage 01 完成结论见 [Gate 1 完成检查](../20260811-gate1-completion/README.md)。
