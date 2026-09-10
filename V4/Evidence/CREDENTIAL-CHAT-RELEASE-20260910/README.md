# Chat 凭证恢复发布准备

用户提供的生产基线：`28f6a603c29986b56985f9e305a82cb6c51a9253`，发布目录 `/Users/stephen/releases/qianliu-model-lifecycle-28f6a60-20260910-152535`，迁移 `0072_admin_roles_security`。该状态来自用户终端回执，本轮未通过 SSH 独立查询。

从该生产提交建立 `codex/credential-chat-release-20260910`，仅重放原修复 `fd444c0`，无冲突。应用候选 `fa864239167a2ca881b0bb7ad6641154da1dc38c`，Tree `134dc87198973319b3554ed26f529581d7357aba`。原 I1 清单 27 个文件的内容指纹完全一致；保留生产的模型停用/归档、DeepSeek 版本展示和系统设置权限代码。

验证：控制面 Chat 探测 13、PostgreSQL 历史迁移与拒绝破坏性回退 1、Web 探测控件/模型停用/版本展示 16，共 30 项通过；全工作区 typecheck 和 Web build 通过。构建仍有现有 chunk 体积提示。未重复执行上一轮完整测试集。

固定版本脚本 `deploy/scripts/release-credential-chat-20260910-mac-mini.sh` 默认 `--preflight`，正式执行需 `--deploy`。预检核对源 Commit/Tree、迁移完整历史、工作区、Compose、容器归属和健康。正式步骤：新目录取得固定候选 → 核对迁移唯一增量 0073 与配置无变化 → 复制原 .env 并核对摘要 → 固定旧镜像 → 在线构建 → 停写 → 数据库备份及目录检查 → 迁移 → 启动与验收 → 切换发布指针。

失败时保留数据库与备份；仅在迁移链等于已知源链或目标链且旧镜像恢复成功时重启上一版应用。不自动 down 或覆盖数据库；无法验证恢复时保持停写并保留发布锁。增量 0073 表有探测记录时，迁移自身拒绝破坏性 down。

复用已有发布模拟器结构，新增 `scripts/rehearse-credential-chat-release.mjs` 针对此脚本执行 18 个隔离命令替身场景，全通过：预检、提交/工作区/锁/迁移历史不符、历史读取失败、Tree/迁移范围不符、构建/备份/停写/迁移失败、迁移已提交后失败、未知迁移、启动/健康失败、正常完成。顺序断言覆盖停写 → 备份 → 检查备份 → 迁移；未知数据库状态禁止启动旧应用。此演练不是真实 Docker/服务器部署。

本轮只准备发布与预检，尚未在 Mac mini 部署，也未证明现场 Kimi 凭证目前有效。生产升级完成后，需要在供给与健康页面手动确认一次最小 Chat 验证，再核对解封与主体模型列表。

## 首次传输失败与脚本修正

用户提供首次运行 `START` 后的 Git `unexpected disconnect / early EOF / invalid index-pack output`；在构建/停服/迁移之前失败。期间两次 pack 大小从 7749631 增至 8077311 字节，证明存在慢速传输，不是一直停在 SSH 握手。

只修改发布脚本：候选是源提交的直接子提交，因此 fetch 深度由 64 降到 2，保留 Commit/Tree/祖先校验；增加 `--progress` 和 SSH ConnectTimeout/ServerAlive 检测。没有改协议、关闭主机校验或改业务候选。失败提示按实际是否进入停服阶段区分。

脚本原 18 个命令替身场景通过；新增 fetch-fail 场景通过，验证不执行 stop/migrate、原服务和指针保持、释放发布锁，并显示未停服/迁移提示。该场景首次断言只读取 stderr，因 tee 将输出合并到 stdout 而失败；改为检查 stdout+stderr 后通过。此处不把模拟测试说成生产已恢复或已部署。
