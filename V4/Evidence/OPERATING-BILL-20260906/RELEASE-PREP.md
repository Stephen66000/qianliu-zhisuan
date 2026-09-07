# 经营账单发布准备

2026-09-07，用户提供的Mac Mini终端事实：当前目录 `/Users/stephen/releases/qianliu-usage-b29df67-20260906-162646`，HEAD `b29df67`，迁移头 `0064_quota_pricing_and_policy_archive`，工作树状态无输出。

待发布业务候选：`a37de1a5c29e30aeb1d7aa84cbffadd331e22115`，Tree `c12d26cd8ddffdc517bb5c88d634a02e139ebdca`，已推送GitHub。本次额外提交只提供发布脚本和此记录，不改变业务候选。

脚本：`deploy/scripts/release-operating-bill-20260907-mac-mini.sh`。沿用现有Mac Mini单Compose发布流程，固定源版本和候选；现场不匹配就停止。保留现有.env、数据库/Redis卷和部署拓扑，不切换主分支。

执行顺序：检查当前版本、迁移及服务状态；取得共享发布锁；获取并核对精确Commit/Tree和唯一新增迁移0065；保存旧应用镜像并在线构建；停业务写入；备份数据库并验证备份目录；运行迁移；切换应用；检查Control/Gateway/Web/Caddy/Worker和数据库版本；最后切换发布指针。

失败时保留数据库，不自动执行迁移down或恢复旧备份。如果0065尚无归属记录，可以恢复旧应用镜像；若已有新归属记录或无法确认状态，保持业务停止并提示人工前滚修复，避免旧归属逻辑忽略新记录。

本地验证：bash语法检查通过；候选祖先、Tree、迁移差异及无依赖/部署拓扑变化由实际Git对象核对。未在生产执行此脚本，未宣称生产发布/回滚已验证。发布由用户在Mac Mini执行，完成后根据COMPLETE回执验收。
