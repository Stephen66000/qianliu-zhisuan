# 经营账单与自动续订发布准备

用户授权推送及升级。业务提交4e92e4af7b90ca9d64c56e7a8d13493dd29e24b1已推至GitHub。

- 固定候选Tree：de2dc05ee7e3bdc8adad194d73ef899def1a33e7。
- 要求生产起点：2b90de19d3d58b175599449613ce31f5b59d3638，迁移0065；现场不符立即停止。
- 唯一迁移：0066_subscription_auto_renewal；依赖及Compose拓扑无变化。
- 使用deploy/scripts/release-operating-feedback-20260907-mac-mini.sh；复用既有迁移发布流程，保留.env，在线构建，暂停应用写入，备份并校验备份可读，迁移再启服务，确认健康、Worker及Control API资金模式ACTIVE，最后切换发布指针。
- 失败停止新服务并检查数据：未产生自动续订或取消事实时可恢复旧应用，保留加性0066；已有新事实或状态未知则保持停止，保留数据库及备份，要求向前修复。绝不自动down或恢复旧备份覆盖新账。
- 本地验证：bash语法通过；精确候选Commit/Tree及唯一迁移核对通过；关键拓扑和锁文件不变；隔离命令桩确认错误生产起点在Docker调用前拒绝。应用验证120项见../SUBSCRIPTION-AUTO-RENEWAL-20260907/validation.json。
- 未在本机执行生产脚本；未声称真实部署或回滚演练完成。需Mac Mini执行并返回COMPLETE，随后核对健康和业务状态。
