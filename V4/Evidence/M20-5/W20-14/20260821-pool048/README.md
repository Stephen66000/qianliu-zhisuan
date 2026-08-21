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
- Provider Adapters：116 tests PASS，含 Messages 转换后 400、非 JSON 400、未知 code/type/param 和多类 canary。
- Web：37 files / 182 tests PASS，含诊断展示与历史 NULL 空态。
- 临时空 PostgreSQL 16（非生产）：0055 迁移 1 test、Control API 13 tests、Gateway 23 tests 全部 PASS；待 Mac Mini PG17 最终复核。
- 全 workspace typecheck／lint／build：PASS；架构 319 生产源文件无 cycle，source-size PASS，重复率 0.66%，production audit／许可证 PASS。
- Sensitive canary：日志 0 hits；新实库测试另断言自定义 prompt／Secret 在诊断 jsonb 中 0 hits。
- 受影响 Provider scope coverage：statements／lines `95.92%`、branches `88.15%`、functions `100%`，达到 `95/85/90`。
- 受影响安全纯函数 mutation：`111/111 killed`，0 survivor、0 no-coverage，score `100%`。
- 新函数 complexity 在禁用 inline config 时仍 `<=30`；未通过豁免规避门禁。
- 双审／V1.4：待最终 Commit 锁定后回填。
