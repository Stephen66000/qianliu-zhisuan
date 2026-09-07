# 059升级准备

用户要求准备部署。本轮未执行生产升级。

- 固定候选feca8603210bcc109346faf03860bfea50d61742，Tree 82d1a4f1553fc362eecaaf18dfbf4c38348687c6。
- 要求生产起点de0a2ec3b7446ab3e0b6d81344d7d84ac2163eab，迁移0066_subscription_auto_renewal；现场脚本重新校验发布目录、HEAD、干净状态、服务和资金ACTIVE配置。
- 变更路径16条，摘要096a953851ddfcdfc2e01e19381a12d74aef832c318ba883197461fb8ca608b0；无新增数据库迁移、依赖锁或Compose／Caddy拓扑变化。
- 脚本deploy/scripts/release-august-overview-20260907-mac-mini.sh复用既有无迁移升级流程：SSH443获取固定提交／Tree，保留.env和旧镜像，在线构建，数据库备份及可读性校验，切换应用，检查HTTP服务和Worker健康，最后切换发布指针。失败恢复旧应用，不回写数据库。
- 本地语法、祖先关系、范围和关键拓扑检查通过；隔离命令桩确认错误起点在Docker调用前拒绝。业务验证54项及构建证据见../AUGUST-OVERVIEW-20260907/README.md，未重复运行未改动的业务测试。
- 线上验收要点：8月月度总览套餐金额与同月订阅记录一致；9月不重复计算8月登记；员工／项目／部门／采购金额无（已计费）后缀；原Token和费用数字保留。
- 待Mac Mini执行及COMPLETE回执；不声称本轮实际部署或回滚演练已完成。
