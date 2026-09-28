# 生产只读预检报告 — unify-stream-idle-timeout-300s

> 日期：2026-09-28（Asia/Shanghai）
> 范围：只读核验生产 Gateway 的实际运行镜像、容器环境、代理链路、公开入口和候选基线关系。
> 边界：未修改服务器文件、环境变量或代理配置；未重启、未替换容器、未推送镜像、未部署。

## 1. 结论

**生产发布当前为 NO-GO；本地代码候选仍为 PASS。**

阻断发布的事实不是候选代码失败，而是：

1. 生产 Nginx 生效的 `proxy_read_timeout` / `proxy_send_timeout` 均为 **600s**，足以让 300 秒空闲错误到达客户端，但低于已确认的 Responses 600 秒总调用时限 + 60 秒错误发送余量，部署时必须提升至至少 **660s**；
2. WorkBuddy 5.5.6 真实公网业务验收（tasks 6.4）仍为 `BUSINESS_PENDING`；
3. 生产部署（tasks 8.3）未授权，本轮没有执行任何发布动作。

## 2. 运行态身份

| 项 | 只读结果 |
| --- | --- |
| 容器 | `ic-gateway`，状态 `running`，启动时间 `2026-09-26T16:20:39.090499951Z` |
| 容器 ID | `b9e4aa73be955571647b2bb8eb368862b449898446eb9ef163fc17b11e349fd3` |
| 实际镜像 ID | `sha256:ca6ad321695fde2330644867430623b46e3db267c28d742a668d5564e0ff7630` |
| 镜像创建时间 | `2026-09-27T00:12:42.88473473+08:00` |
| 镜像标签 | `ic-gateway:latest`；OCI revision/source/version 标签缺失 |
| 端口 | 容器 `8787/tcp` → 主机回环 `127.0.0.1:9093` |
| Docker healthcheck | 未配置（`HEALTH none`） |
| 应用健康 | `http://127.0.0.1:9093/health` → 200；`https://ic-gw.qianliuai.com/health` → 200 |

Compose 标签显示实际工作目录为 `/root/docker/qianliu-zhisuan-release-cffa89c/deploy/bt`，该发布目录是无 `.git` 的复制目录。服务器上的另一个源码检出 `/root/docker/qianliu-zhisuan` 位于 `d1c3984503cac6af656caa77b0e319fe023c5d50`（`deploy/kimi-fix-20260922`），且含未跟踪 `deploy/bt/`；它不是当前容器 Compose 标签指向的工作目录，不能把该检出误当成正在运行的发布源。

由于当前生产镜像没有 revision 标签，不能仅凭镜像元数据证明完整源码提交。为缩小不确定性，对容器内三个与本变更直接相关的运行时源码文件做 SHA-256 指纹；它们均与本地基线 `cfe818e`（也与 `d1c398` / `cffa89c` 对应文件）一致，且均不同于候选 `30337df`：

| 文件 | 生产容器 SHA-256 | 候选状态 |
| --- | --- | --- |
| `apps/gateway/src/main.ts` | `53236208c4e2edf7a3681781ee437cc80d9773fca112fb4b02b56eaa3d8b41aa` | 尚未包含候选改动 |
| `apps/gateway/src/upstream-timeout-policy.ts` | `9b51561597943fa547dc7628091e4c833287c736be9894f0bcf91fb51902560d` | 尚未包含候选改动 |
| `packages/provider-adapters/src/openai-compatible-timeout.ts` | `e2e2cbec1eea14438e18c6ee617b4667d6417ecbaea9b2a68feab6b022174347` | 尚未包含候选改动 |

## 3. 生效时限矩阵（已脱敏）

| 层 | 生效值 | 判断 |
| --- | ---: | --- |
| Gateway 全局流式空闲 | `GATEWAY_UPSTREAM_STREAM_IDLE_TIMEOUT_MS=45000` | 当前仍为 45 秒，候选未部署 |
| Gateway 全局首字节 | `GATEWAY_UPSTREAM_FIRST_BYTE_TIMEOUT_MS=30000` | 本变更保持不动 |
| Kimi 首字节 | `GATEWAY_KIMI_FIRST_BYTE_TIMEOUT_MS=120000` | 本变更保持不动 |
| Gateway 总调用 | `GATEWAY_UPSTREAM_REQUEST_TIMEOUT_MS=600000` | 600 秒 |
| 厂商/模式 idle 覆盖 | 未发现 DeepSeek / Zhipu / Kimi 的 idle override | 无需清理已存在的旧 idle 覆盖；发布仍应按变量名白名单复核 |
| Nginx 响应缓冲 | `proxy_buffering off` | 满足 SSE 透传 |
| Nginx 读超时 | `proxy_read_timeout 600s` | 覆盖 300 秒空闲，但不满足 660 秒发布目标 |
| Nginx 写超时 | `proxy_send_timeout 600s` | 同上 |

## 4. 实际公网链路

生效站点配置：`/www/server/panel/vhost/nginx/ic-gw.qianliuai.com.conf`。

链路为：

`https://ic-gw.qianliuai.com/*` → 宝塔 Nginx `location /` → `http://127.0.0.1:9093` → `ic-gateway:8787`。

只读探测结果：

- `https://ic-gw.qianliuai.com/health` → 200；
- `https://ic-gw.qianliuai.com/v1/models`（无鉴权）→ 401，说明公网请求确实进入 Gateway 鉴权层；
- `https://gw.qianliuai.com/health` → 404，且解析到另一主机，因此 `gw.qianliuai.com` 不是本次服务器上已验证的 Gateway 入口。

## 5. 候选与生产基线关系

- 代码候选：`30337df87ba721bcab932d77d880f50649374bc9`；基线 `cfe818ec861d3f066a15b9d0759b72a962841645`。
- 服务器普通源码检出 `d1c398…` 是候选祖先，但不是实际 Compose 工作目录。
- 实际发布目录名指向 `cffa89c`，且三个关键运行文件与 `cffa89c` / `cfe818e` 均一致；`cffa89c..cfe818e` 之间是 provider-finance 相关提交，未修改这三个关键文件。
- 候选镜像已有精确 OCI revision 标签；生产发布时必须保留该标签并在替换后分别核验：镜像 ID/标签、容器实际 Image ID、容器环境、Nginx 生效配置和公网响应。

## 6. 发布前必须完成

1. 取得单独的 tasks 8.3 生产部署授权；
2. 将本入口 Nginx 读/写超时从 600s 调整到至少 660s，并先做配置语法检查；
3. 使用带 `org.opencontainers.image.revision=30337df…` 的候选镜像，不从服务器上 `d1c398…` 的普通源码检出直接构建；
4. 替换后确认有效空闲门限为 300000ms，且不存在旧厂商/模式 idle 覆盖；
5. 完成 WorkBuddy 5.5.6 公网慢流业务验收，分别记录中文提示、请求 ID 与 3003 包装；
6. 技术部署与业务接受分开记账；任一失败立即按已归档原镜像 ID与原配置回滚。

## 7. 只读证据命令类别

本轮使用的命令仅包括：`git log/status/merge-base/diff`、`docker inspect/image inspect/exec sha256sum/logs`、`ps`、`ss`、`grep`、`curl` 健康与未授权路由探测。未使用任何写入、重启、reload、compose up/down、镜像构建或配置修改命令。
