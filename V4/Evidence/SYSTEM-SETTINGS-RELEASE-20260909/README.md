# 系统设置部署准备

本地部署准备通过。生产只读预检、正式部署和页面验收尚未执行。应用已通过本次限定范围的 I1 复审；本目录增加发布工具和发布演练，不重开业务审核。

## 固定版本

| 项目 | 值 |
| --- | --- |
| 生产起点 Commit | `eb1ed123ec8e919cad0e78947c9cd9c441dee352` |
| 生产起点 Tree | `bb364298d362c22c7628b7f0d36e160563b0deaf` |
| 起始迁移 | `0070_alert_recovery_evidence` |
| 应用 Commit | `72456694118f42c51f199c95a24e665bc7d25fca` |
| 应用 Tree | `7b6f1e690bfdf305defbf15ae60cbe5625807cb4` |
| 迁移顺序 | `0071_enterprise_contact_details` → `0072_admin_roles_security` |
| 发布脚本 SHA-256 | `25956d464d95a23743b78378bc2629f9620f63909f6ac145286600463b58c612` |

起点来自“整理运行保障与管理员清单”任务中用户提供的 COMPLETE 回执：`/Users/stephen/releases/qianliu-runtime-admin-20260909-121546.Tvw5UA`，四个 HTTP 入口 200、Worker healthy。此回执不是当前现场状态证明。脚本会重新比较发布指针、源码 Commit/Tree、完整迁移集合、容器归属及健康状态；任何不符即停止。

应用包含企业信息、账号与安全、审计日志、关于版本。相对生产起点只增加上述两份迁移；保留 0069 身份验证错误证据和 0070 恢复证据，Compose、依赖锁文件及 Caddy 配置不变。现有管理员统一赋予 SUPER_ADMIN，保留密码哈希、启停状态、归档状态、会话和历史审计引用。

发布工具提交与应用提交分开。脚本部署的始终是表中的精确应用版本；仅在新发布目录的 `.env` 写入该 Commit 作为 `APP_VERSION`，供“关于版本”展示。旧发布环境文件不改动。

## 第一步：Mac mini 只读预检

在 Mac mini 终端执行这一个命令组，保留终端并返回输出：

```bash
settings_release_tools="$(mktemp -d /Users/stephen/qianliu-settings-tools.XXXXXX)" &&
git clone --depth 1 --single-branch --branch codex/system-settings-v1-20260909 \
  ssh://git@ssh.github.com:443/Stephen66000/qianliu-zhisuan.git "$settings_release_tools" &&
test "$(shasum -a 256 "$settings_release_tools/deploy/scripts/release-system-settings-20260909-mac-mini.sh" | awk '{print $1}')" = 25956d464d95a23743b78378bc2629f9620f63909f6ac145286600463b58c612 &&
bash "$settings_release_tools/deploy/scripts/release-system-settings-20260909-mac-mini.sh" --preflight
```

命令下载工具到独立目录；预检本身不停止服务、不构建、不备份、不迁移、不创建部署锁。成功应输出 `PREFLIGHT PASS source=eb1ed123... migration=0070_alert_recovery_evidence candidate=72456694... target=0072_admin_roles_security`。失败时核对实际现场，不修改固定版本绕过。

## 第二步：回执确认后正式部署

等预检回执核对并确认正式部署后，才在同一终端执行：

```bash
bash "$settings_release_tools/deploy/scripts/release-system-settings-20260909-mac-mini.sh" --deploy
```

脚本重新预检，取得共用部署锁，下载并核验应用 Commit/Tree、祖先关系和两份迁移的 SHA-256，保存旧镜像，在旧服务运行时构建新镜像。随后停止并核验全部业务服务，备份数据库并检查备份可读性，执行迁移，启动新服务并检查容器归属、镜像、迁移集合、重启次数和健康状态。只有全部成功才更新发布指针并输出 COMPLETE。停止服务至健康验证期间有维护中断。

备份位于 `/Users/stephen/backups/qianliu-zhisuan`，日志位于 `/Users/stephen/logs/qianliu-zhisuan`；确切路径和备份摘要由 COMPLETE 输出。需要保留旧镜像、数据库备份及日志，直到业务验收完成。

## 失败恢复边界

- 停服前失败：保留旧服务，若已构建则恢复旧镜像标签。
- 停服后失败：停止并核验业务服务，确认迁移集合完全等于 0070、仅新增 0071 或完整新增 0071/0072，才继续判断旧版兼容性。
- 完整迁移至 0072 后，仅当不存在 `admin_role`、没有 CUSTOM 管理员、所有企业 `security_version` 均未超过 1，才允许恢复旧应用。旧版给所有管理员完整权限，新岗位或安全策略一旦使用，回退旧应用会破坏权限约束。
- 迁移历史未知、查询失败、新权限或安全策略已使用、停服/恢复无法核实：保持业务停止，保留数据库、备份和部署锁，人工核对并向前修复。
- 不自动执行 down 迁移，不自动还原数据库备份。即使旧应用恢复成功，新增列可能保留；再次发布须先核对现场迁移状态，不能盲目重跑。

## 本地验证证据

- `script-rehearsal.json`：实际发布 Shell 在隔离命令替身下运行，21 个场景通过，含只读预检、起点不符、构建/备份/迁移/启动失败、仅完成 0071、权限配置后拒绝回退和成功路径。不是真实服务器部署。
- `pg-rehearsal.log`：真实 PG17，0070 的自定义格式备份可恢复；0071/0072 升级保留账号、会话、审计引用；提取脚本中的原始 SQL，分别验证岗位、CUSTOM 账号和安全策略都阻止旧版回退。
- `verification.json`：固定版本、脚本及演练代码摘要。
- 应用限定 I1 复审见 `../SYSTEM-SETTINGS-V2-20260909/I1-RECHECK/review-report.md`。

## 部署后业务验收

核对 COMPLETE 中的 Commit、Tree、迁移 0072、四个 HTTP 200 及 Worker healthy。随后以现有超级管理员登录，检查企业信息保存、自定义岗位名称与权限、受限账号实际可见范围、登录安全和会话撤销、审计日期选择及操作人详情、关于版本显示 `7245669...`。健康回执不能替代这些页面操作验收；试配岗位或安全策略后禁止退回旧的全权限应用。
