# 8月总览套餐费用与金额后缀

本地修复完成，未提交、推送或部署。生产仍为de0a2ec。

根因：057将历史订阅接入资金历史、采购分析和月度资金摘要，但loadResourceFinanceViews的monthlyPlanCashCny仍只查新provider_finance_event。月度总览使用这条资源投影，覆盖了旧套餐费用为0。本次资源投影复用registeredSubscriptionHistory，按原登记月份与asOf过滤，和新流水合并，继承历史采购迁移去重。

按用户要求移除金额后的（已计费）及采购表同类小字，员工／项目／部门／采购统一只显示金额。apiCost与knownApiCost及完整性字段保留原语义；不改变计价、不补造历史费用或重写封账。

验证54项：数据库30、Web24。8月真实PostgreSQL夹具启用与线上一致的ACTIVE及strict finance契约，直接调用OperatingBillRepository.getBill验证套餐合计和Kimi／智谱厂商金额，再检查9月不重复；另验证旧采购迁移前后资源费用始终只算一次。原账户分配和封账回归通过。Database／Web类型、增量Lint、架构、源码体积、diff检查及Web构建通过。金额后缀源码检索无剩余。构建保留原大包提示。

测试日志database-final.log、web.log；构建build.log。本轮修复不需要新迁移，未修改生产页面或数据。此为作者I0核查，不声称独立V1.4审核或线上业务验收完成。

提交说明：用户已授权本轮commit；文内未提交状态为验证时快照，实际提交以Git记录为准。未推送或部署。
