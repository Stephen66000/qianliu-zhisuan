# 生产部署回执 — unify-stream-idle-timeout-300s

> 日期：2026-09-28（Asia/Shanghai）
> 状态：`TECHNICAL_DEPLOYMENT_PASS / BUSINESS_ACCEPTANCE_PENDING`
> 授权：用户在生产只读预检结论后单独确认继续，授权 tasks 8.3 所需的候选推送、Nginx 660 秒调整、Gateway 镜像替换和上线核验。

## 1. 结论

生产 Gateway 技术部署通过：精确代码候选 `30337df87ba721bcab932d77d880f50649374bc9` 已在服务器原生 amd64 环境构建并运行；统一流式空闲门限 300000ms 已生效；Nginx SSE 代理读写超时均为 660s；公网健康和鉴权边界正常。

本次只替换 Gateway 并热加载对应 Nginx 站点配置，未执行数据库迁移，未重启 Control API、Worker 或 Web。WorkBuddy 真实慢流业务验收尚未执行，不随技术部署自动通过。

## 2. 发布对象

| 项 | 结果 |
| --- | --- |
| 代码候选 | `30337df87ba721bcab932d77d880f50649374bc9` |
| 推送分支 | `origin/codex/stream-idle-timeout-300s-20260927` |
| 服务器 release | `/root/docker/qianliu-zhisuan-release-30337df`（由精确候选 `git archive` 生成，生产 `deploy/bt` 目录从上一 release 复制后仅调整本变更变量） |
| 生产镜像 | `sha256:f24f1545b55953796404095295789744c2d033198609539a784321ef4d821d47`，linux/amd64 |
| OCI revision | `30337df87ba721bcab932d77d880f50649374bc9` |
| OCI version | `stream-idle-300s-30337df` |
| 运行容器 | `ic-gateway`，容器 ID `b02158b4f02e2d1e711845b2789fc9c94b12f01c964b5ea04040cf52c2c4d6a1` |
| 启动时间 | `2026-09-28T05:53:17.389575004Z` |

服务器构建前已验证候选关键源码 SHA-256：

- `apps/gateway/src/upstream-timeout-policy.ts`：`38830d869037bb0278ef5016a6faf2043b57d5112330286fb41dcf12620cf123`；
- `packages/provider-adapters/src/openai-compatible-timeout.ts`：`a094b55209ab5873a1fa9865d4f8dac069147c6dd993f1603ed031f040b71522`。

## 3. 配置与代理

运行容器有效时限：

| 变量 | 生效值 |
| --- | ---: |
| `GATEWAY_UPSTREAM_STREAM_IDLE_TIMEOUT_MS` | 300000 |
| `GATEWAY_UPSTREAM_REQUEST_TIMEOUT_MS` | 600000 |
| `GATEWAY_UPSTREAM_FIRST_BYTE_TIMEOUT_MS` | 30000 |
| `GATEWAY_KIMI_FIRST_BYTE_TIMEOUT_MS` | 120000 |
| DeepSeek / Zhipu / Kimi 厂商或模式 idle 覆盖 | 0 个 |

Nginx 生效配置：

- `proxy_buffering off`；
- `proxy_read_timeout 660s`；
- `proxy_send_timeout 660s`；
- `/www/server/nginx/sbin/nginx -t` 通过并成功热加载。

## 4. 验证结果

| 验证 | 结果 |
| --- | --- |
| 候选独立烟测容器 | `/health` 200，进程 running；清理后再切换正式容器 |
| 正式本机入口 | `http://127.0.0.1:9093/health` → 200 |
| 服务器经公网入口 | `https://ic-gw.qianliuai.com/health` → 200 |
| 独立外部客户端 | `https://ic-gw.qianliuai.com/health` → 200 |
| 鉴权边界 | 公网 `/v1/models` 无鉴权 → 401 |
| 镜像/容器绑定 | 容器 Image ID 与候选镜像 ID 一致；镜像 OCI revision 为 `30337df…` |
| 生效环境 | idle=300000ms；旧 idle 覆盖=0 |
| 启动日志 | 错误行 0；弃用提示 0 |
| 其他服务 | `ic-control-api`、`ic-worker`、`ic-web` 启动时间和 Image ID 未变化 |

切换前主机 9093 已建立连接数为 0。Compose 仅执行 `gateway` 的 `--no-deps --no-build --force-recreate`，健康检查在允许窗口内通过；没有触发自动回滚。

## 5. 回滚资产

- 原镜像已保留为 `ic-gateway:rollback-20260928-ca6ad321`，ID `sha256:ca6ad321695fde2330644867430623b46e3db267c28d742a668d5564e0ff7630`；
- 原 release 目录 `/root/docker/qianliu-zhisuan-release-cffa89c` 保留；
- 原 Nginx 站点配置保留为 `/www/server/panel/vhost/nginx/ic-gw.qianliuai.com.conf.pre-stream-idle-300s-20260928`；
- 新 release 的原 45 秒环境副本保留为 `deploy/bt/.env.pre300`；
- 本变更无数据库迁移，因此回滚不涉及数据结构或数据修复。

## 6. 业务接受边界

当前 WorkBuddy 实际版本为 5.6.2，实际选择模型为 `ql-glm-5.3-flash`。用户已执行一条无敏感数据的正常流式冒烟请求；客户端完整返回 `STREAM_SMOKE_01` 至 `STREAM_SMOKE_20`，并以 `STREAM_IDLE_300S_DEPLOYMENT_SMOKE_OK` 正常结束，未出现 3003。因此正常 WorkBuddy → 公网 Gateway → 智谱模型链路记为 **PASS**。

该请求没有发生连续 300 秒上游静默，不能证明真实断流时的中文提示和 3003 包装。按用户决定，不再人为制造故障或继续扩大测试；tasks 6.4 继续保持 `BUSINESS_PENDING`，等待真实环境自然反馈。若再次发生，按错误时间、Request ID、模型和客户端错误报告核对 `failure_layer=STREAM_IDLE_TIMEOUT` 与约定中文提示。
