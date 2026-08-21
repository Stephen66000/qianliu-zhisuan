# POOL20-048 上游 400 脱敏诊断 Evidence

- 基线：`e2d64e93d5bd47612c162035796610358b6def2d` / Tree `c35c39e1ab7a9f5cfd0b653558b47ce6901d4bab`
- 分支：`codex/v2.1-upstream-error-evidence`
- 范围：仅 HTTP 400 的 Attempt 脱敏错误证据、请求形状摘要、既有下钻展示和 `0055`。
- 零留存：不保存 provider raw message、prompt／response、工具名／描述、Schema 属性名／值、Secret 或 API Key。
- 不变合同：400 不重试，不切换上游，0 Token／0 费用，不污染资源健康。
- 迁移：`0054_usage_aggregate_settlement_time → 0055_upstream_error_evidence`；旧行为 NULL，单列 JSON 不超 4KB，有证据时 down fail-closed。
- 发布：新增 `deploy/scripts/release-v2.1-pool048-mac-mini.sh`，不改写已执行的 r2 历史脚本。

## 验证记录

- Contracts / Provider Adapters / Database / Control API / Gateway / Web typecheck：PASS。
- Contracts：4 tests PASS。
- Provider Adapters：131 tests PASS，含 Messages 转换后 400、非 JSON 400、未知 code/type/param 和多类 canary。
- Web：37 files / 182 tests PASS，含诊断展示与历史 NULL 空态。
- PostgreSQL 17 Testcontainer（与生产同主版本，不连接生产库）：0055 迁移 1/1、Control API 13/13、Gateway 24/24 PASS。覆盖 0054→0055、旧行 NULL、成对／仅400／4KB 约束、非法对象、down fail-closed、清空后 down/re-up、租户 404、0 Token／0 费用、不重试与资源健康不污染。
- 全 workspace typecheck／lint／build：PASS；架构 319 生产源文件无 cycle，source-size PASS，重复率 0.66%，production audit／许可证 PASS。
- Sensitive canary：日志 0 hits；新实库测试另断言自定义 prompt／Secret 在诊断 jsonb 中 0 hits。
- 受影响 Provider scope coverage：statements／lines `97.33%`、branches `91.83%`、functions `100%`，达到 `95/85/90`。
- 受影响安全纯函数 mutation：`111/111 killed`，0 survivor、0 no-coverage，score `100%`。
- 新函数 complexity 在禁用 inline config 时仍 `<=30`；未通过豁免规避门禁。
- 双审／V1.4：业务／隐私与迁移／发布 Finding 已整改；PG17 唯一 Evidence Gap 已关闭，待本 Evidence 提交后做最终 Commit／Tree 一致性确认。
