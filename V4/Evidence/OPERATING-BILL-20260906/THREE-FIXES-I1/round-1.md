# 第一轮独立回传：FAIL，1项P2

Reviewer `/root/operating_v14_review`，未参与本轮实现。2026-09-07 06:06:37—06:13:15 UTC，约6分39秒。首尾27/27 SHA一致，摘要4e0414ccf0c8d4c5d9899d060dafe6c4c356923b06cbdf835e82fb5dbd978b83，业务e4a4f87，审核HEAD d6b9dd3。

F1/P2：principal-attribution-backfill.ts在取得月份屏障前检查预览指纹，等待锁后直接使用旧集合。隔离PostgreSQL复现previewCount=1、observedMonthLockWait=true；期间第二条符合条件的请求提交后，确认仍成功1条、剩余1条，没有按合同返回CONFLICT。没有观察到扩写新增记录、覆盖旧快照或修改原始费用。

最小修复：取得全部月锁后再次inspect并核对原指纹，变化则整笔拒绝，不扩写新增记录；仅补这一条并发回归。复现脚本和原始结果见three-fixes-race-review.mts/log。

七维结论：结构职责PASS、资源/并发FAIL(F1)、依赖架构PASS、配置安全PASS、类型数据错误FAIL(F1)、注释可读性PASS、测试语义FAIL(缺少该窗口)。其余三项修复未发现具体缺陷。作者47项定向测试、构建及主会话本候选机械检查已核对；Reviewer独立运行的只有此隔离复现。不扩展覆盖率、ratchet、Mutation治理。

主会话后续整改：生产函数增加锁后指纹比较，测试增加唯一并发回归。race-red.log为修复前失败，race-green.log为修复后4项通过。Lint和数据库类型检查通过。已冻结candidate-r2.json，业务1bc26e3，发布脚本提交56818a1；本地提交尚待独立复核通过后推送。
