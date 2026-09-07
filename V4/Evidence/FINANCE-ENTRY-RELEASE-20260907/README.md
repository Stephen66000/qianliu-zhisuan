# 057／058订阅入口与费用展示升级

用户已授权部署。脚本：deploy/scripts/release-finance-entry-20260907-mac-mini.sh。

- 固定候选：de0a2ec3b7446ab3e0b6d81344d7d84ac2163eab；Tree：8a467b9a21b200787a2b0af026aed320cbe83acf。
- 要求生产起点：db78a30ef8b6989887baf7cdc1637d3378e8f89e；迁移必须为0066_subscription_auto_renewal。目录HEAD及干净状态在现场检查，不能跳过。
- 唯一变化范围绑定49条路径及摘要60ff511e151c0dd2b7921152d983fbeb39804e0189c5b71531a4a1b6ced753d1；无新迁移、依赖锁、Compose或Caddy拓扑变化。
- 保留.env和原应用镜像；SSH443获取精确版本，在线构建，备份并检查备份可读性，然后更新应用，核对服务健康、镜像和配置路径、资金ACTIVE开关，最后更新发布指针。
- 失败恢复旧应用和指针，不还原数据库、不丢弃期间新增的订阅和流水。
- 本地语法、Commit/Tree/祖先关系、范围和拓扑检查通过；隔离命令桩证实错误生产起点在Docker调用前拒绝。复用已有无迁移升级逻辑。应用97项定向测试与构建见OPERATING-COST-20260907证据。
- 待Mac Mini现场执行及COMPLETE回执；未声称本轮生产部署或回滚演练已完成。

## 生产部署完成

2026-09-07收到用户COMPLETE回执：de0a2ec及Tree与目标一致，0066迁移保持，四个HTTP服务200，Worker healthy，备份及SHA256已提供。详见production-receipt.json。台账057／058更新为已部署。此结论来自用户现场脚本回执；页面业务验收仍待用户核对，不将服务健康等同于业务验收。上文待部署为执行前记录。
