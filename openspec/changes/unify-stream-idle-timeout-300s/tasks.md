# Tasks

> 状态：`IMPLEMENTATION_AUTHORIZED_LOCAL_ONLY`（2026-09-27 授权 WP1—WP5 及 8.1—8.2；2026-09-28 追加授权受控环境预验收与本地候选镜像构建；推送、生产配置修改与生产发布 8.3 仍未授权）。
> 1.2 已于 2026-09-28 通过生产只读预检补齐；6.4 因 WorkBuddy 隔离客户端条件暂缺，保持未勾选并登记为 BUSINESS_PENDING。
> 2026-09-28 受控预验收完成：候选镜像已从 30337df 真实构建并通过 /health 预检（8.1/8.2 据实勾选）；4.2 数据库级租约回归 10/10 通过（隔离 PostgreSQL）；6.3 全链路受控验证通过（加速 T1/T2/T3 + 真实时间 340.4 秒 T4）。详见 `V4/Evidence/unify-stream-idle-timeout-300s/controlled-validation-20260928/预验收报告-20260928.md`。

## 1. 基线与证据

- [x] 1.1 从与生产提交核对过的基线创建隔离工作区，记录分支、提交和初始状态，并验证没有带入当前工作区的其他任务改动。（2026-09-27：worktree 基线 origin/main cfe818e，分支 codex/stream-idle-timeout-300s-20260927）
- [x] 1.2 只读采集生产 Gateway 镜像、容器环境中的全局及旧空闲变量、资源模式和实际公网代理链，交付脱敏时限矩阵并验证每个结论都有命令或页面证据。（2026-09-28：生产只读预检完成；运行镜像 `sha256:ca6ad321695f…`、容器有效全局空闲门限 45000ms、未发现厂商/模式 idle 覆盖；公网入口 `ic-gw.qianliuai.com` 经宝塔 Nginx 转发至 `127.0.0.1:9093`，`proxy_buffering off`、读/写超时均 600s。600s 足以覆盖 300s 空闲提示，但低于 Responses 总时限 600s + 60s 发送余量，部署前须调整至至少 660s。证据：`V4/Evidence/unify-stream-idle-timeout-300s/production-readonly-preflight-20260928.md`）
- [x] 1.3 用当前候选复现 299 秒恢复和 300 秒空闲失败，记录实际 `failureLayer`、底层异常、Attempt 和客户端表现，并验证复现不使用生产用户流量。（2026-09-27：假时钟边界测试 + 真实本地 HTTP 慢流 300 秒/299 秒真实时间复现，全部本机回环合成流量）

## 2. 统一流式空闲策略

- [x] 2.1 将正式 Gateway 空闲默认值和通用 Caller 回退值改为 300000，移除智谱 Coding Plan 特例及厂商／模式覆盖生效路径，并用策略单测验证所有厂商和模式解析为 300000。
- [x] 2.2 为已知旧 `*_STREAM_IDLE_TIMEOUT_MS` 变量增加一次性脱敏弃用提示并更新 `.env.example`，用启动测试验证旧值不生效、变量值不进入日志、非法全局值仍失败关闭。
- [x] 2.3 保持模型发现、权限探针和模型验证的显式时限不变，用相关定向测试验证管理调用没有继承 300 秒正式调用门限。

## 3. 上游数据与 HTTP 计时

- [x] 3.1 修改 SSE 原始块计时，仅由 `byteLength > 0` 的块刷新空闲窗口，并用假时钟测试覆盖零长度块、合法注释／心跳、299 秒恢复、多次重置和异常 EOF；补充分层超时 `dispose()` 之后无残留定时器回调、不产生重复终止或重复结算的断言。
- [x] 3.2 为生产 Caller 装配显式 Undici dispatcher，使 body timeout 由空闲门限加 30 秒余量派生，并用配置单测验证它晚于业务空闲门限且 headers timeout 覆盖有效首字节门限。
- [x] 3.3 使用真实本地 HTTP 慢流执行 300 秒边界测试，验证业务层产生 `STREAM_IDLE_TIMEOUT`，而不是 Undici body timeout 或 `UPSTREAM_NETWORK`。（2026-09-27：真实时间 300 秒本机回环慢流实测通过，实测耗时约 300 秒且早于 bodyTimeout 330 秒）
- [x] 3.4 验证 600 秒总调用时限先到时仍产生 `REQUEST_TIMEOUT`，并用测试确认它没有套用流式空闲提示。（沿用既有 caller 定向测试 + 新增"其他失败层不套用空闲提示"表驱动断言）

## 4. 并发租约与清理

- [x] 4.1 从生产 runtime 的 `requestTimeoutMs` 同源派生 Coding Plan 并发租约 TTL（总时限加 60 秒），显式传入租约仓储，并用装配测试验证默认值不再是 60 秒。
- [x] 4.2 增加长请求租约回归，验证跨越 300 秒窗口时租约不会被回收或重复放行，请求完成、取消和超时后均只释放一次。（2026-09-28 受控环境补齐：隔离 PostgreSQL（postgres:17-alpine pinned digest）真实迁移 + 真实 QuotaGateRepository SQL，确定性时钟推进 10/10 通过——660 秒 TTL 落库、t+300s 不提前回收且并发满不重复放行、释放幂等（重复释放不改变 released_at）、expires_at 严格边界（恰在 expires_at 不回收、+1ms 回收并放行）；同源派生 concurrencyLeaseTtlMs=660000 断言通过。证据：controlled-validation-20260928/logs/lease-regression.log）
- [x] 4.3 回归额度预占和失败结算，验证部分用量保持既有质量标记、未知用量不伪造为精确零值、没有重复结算。（沿用既有 attempt-usage-settlement 定向回归）

## 5. 错误合同与 Attempt 边界

- [x] 5.1 按 `failureLayer` 生成北向错误文案，使只有 `STREAM_IDLE_TIMEOUT` 返回约定中文提示，并用表驱动测试覆盖首字节、空闲、总时长、取消、限流、鉴权和传输错误。
- [x] 5.2 在已提交的 Chat／Messages 流内错误和未提交的 HTTP 504／Responses 聚合失败中保留机器码、故障层和真实请求 ID，并用三协议集成测试验证实际响应结构。（2026-09-27：chat/messages/responses 三 capability 北向错误合同以 fastify inject 实测；未提交 504 携带 message/code/failure_layer/request_id）
- [x] 5.3 让 failover 策略对 `STREAM_IDLE_TIMEOUT` 明确终止，用测试验证 Attempt 1 空闲超时不启动 Attempt 2，以及此前已合法切换时 Attempt 2 空闲超时不启动 Attempt 3。

## 6. 下游协议与代理

- [x] 6.1 回归 Messages 五秒 ping，验证 ping 在空闲期间持续发送、客户端可解析且不会刷新上游空闲计时。（2026-09-27：messages-protocol 定向回归通过；ping 为下游活动，上游计时只由非空原始块刷新，单测覆盖）
- [x] 6.2 验证 Chat 已提交后连续空闲 300 秒时，可控代理保持连接直至收到流内错误；记录并验证生效的代理指令和数值。（2026-09-27：北向端到端真实 300 秒实测——慢上游→Gateway /v1/chat/completions（真实 Chat 路由+StreamWriter）→本地可控反代→HTTP 客户端，实测 301.4 秒收到 `code=upstream_timeout`+约定中文文案+真实 request_id 流内错误帧并正常收尾；Caller 层 300 秒计时另由 real-slow-stream-idle.test.ts 真实时间实证。2026-09-28 生产只读核验：Nginx `proxy_buffering off`、`proxy_read_timeout 600s`、`proxy_send_timeout 600s`，可覆盖本场景；Responses 600s 总时限仍须按 6.3 在部署时提升代理至至少 660s。）
- [x] 6.3 验证 Responses 上游持续有数据但下游聚合等待超过 330 秒时仍保持连接，并将可控 `/v1/*` 入口等待配置为覆盖 600 秒总时限及至少 60 秒发送余量。（2026-09-28 受控全链路补齐：慢上游（9399，仅回环）→ 候选 Gateway 容器（镜像 qianliu-gateway:stream-idle-300s-30337df）→ 可控反代（58080，requestTimeout=0/headersTimeout=660s/keepAliveTimeout=660s/upstreamSocketIdle=720s，全部 ≥660 秒或显式关闭）→ HTTP 客户端。加速路径 T1 Responses SSE 完整事件流/T2 非流式 JSON/T3 上游 401 错误合同（502 + code=invalid_api_key + request_id + failure_layer=UPSTREAM_HTTP）全过；真实时间 T4：上游每 10 秒持续发数据约 335 秒，聚合等待 340.4 秒连接保持并返回完整 Responses SSE（ai_request SUCCEEDED、response_committed=t）。注：并发租约仅 CODING_PLAN 资源获取，本 E2E 资源为 API 模式；租约行为由 4.2 数据库级回归覆盖。证据：controlled-validation-20260928/logs/client-t1-t3.log、client-t4.log、upstream.log、proxy.log）
- [ ] 6.4 通过 WorkBuddy 5.5.6 运行等效公网慢流，记录中文提示、请求 ID 和 3003 包装；若客户端提前断开，明确标记业务验收失败并停止宣称完整支持。（BUSINESS_PENDING：需 WorkBuddy 真实客户端与公网链路）

## 7. 候选验证

- [x] 7.1 运行 Gateway 和 provider-adapters 相关定向测试，验证策略、Parser、HTTP、failover、协议和租约场景全部通过，并保存与候选提交绑定的结果。（2026-09-27：provider-adapters 132 / gateway 74 定向通过；真实慢流集成 3 项通过，结果绑定候选提交）
- [x] 7.2 运行受影响包 typecheck、lint 和 build，验证新增改动无错误；既有全仓失败单独记录，不扩大修复范围。（2026-09-27：两包 typecheck/lint/build 全部 exit 0）
- [x] 7.3 对照 `stream-idle-resilience` 的每个 Requirement 和 Scenario 建立证据索引，逐项标记通过、失败或不适用，确认没有以单测替代真实代理和客户端验收。（2026-09-28：见验证报告、受控预验收报告与生产只读预检；1.2/6.3 已补齐，6.4 如实保持 BUSINESS_PENDING）

## 8. 发布准备与授权闸门

- [x] 8.1 生成候选镜像、环境变量差异、代理差异和回滚步骤，验证原镜像与原配置可恢复且没有数据库迁移。（2026-09-28：候选镜像已从精确提交 30337df87ba（detached build worktree，非 evidence carrier）真实构建：qianliu-gateway:stream-idle-300s-30337df，ID sha256:b6799eb235c6…，linux/arm64，构建 exit 0，OCI 标签 org.opencontainers.image.revision/source/version；/health 预检 200；容器级受控链路验证通过。环境变量/代理差异与回滚步骤见部署差异文档；本变更迁移头与基线一致（head=0084，无新增迁移）。镜像仅存本地，未推送 Registry）
- [x] 8.2 在不修改生产的前提下提交代码验证、候选镜像、部署步骤和回滚证据供审核，并确认生产部署任务保持未执行。（2026-09-28：代码验证（前两轮门禁证据）、候选镜像（8.1）、部署步骤与回滚证据均已交付且绑定候选 30337df；4.2/6.3 受控验证补齐后本项文字与交付一致。生产部署任务 8.3 保持未执行、未授权；未推送、未修改生产配置）
- [ ] 8.3 仅在取得单独部署授权后选择合适窗口发布，核验服务器提交／镜像／容器／路由／公网响应与 WorkBuddy 结果，并将业务接受与技术部署分别记录。
