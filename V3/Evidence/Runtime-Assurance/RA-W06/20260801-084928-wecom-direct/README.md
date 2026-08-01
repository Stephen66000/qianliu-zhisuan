# RA-W06 企微成员应用消息 Evidence

- 时间：2026-08-01 08:49 Asia/Shanghai
- 实现：唯一官方 Host `qyapi.weixin.qq.com`；自建应用 token 内存缓存和过期刷新；仅用 `touser=userid` 向本人发送固定触发／恢复模板；模板包含中文原因、影响对象、备用资源策略、持续时长和可配置的后台详情链接；不支持群、群机器人或 Webhook。
- 可靠性：事件＋人员＋通知类型幂等；事件建立事务级 advisory lock，并发命中只有一个活跃事件；人主体和项目负责人均进入去重后的触发／恢复链。限频／网络错误指数退避，最多 5 次；缺失、无效 `userid` / 不在可见范围均明确记录，不影响 Gateway 或熔断事件。
- Secret：页面只返回掩码和指纹；数据库只存 AES-256-GCM 密文；Worker 解密后只用于换 token；Secret/token 均不进普通日志或 Evidence。
- 验证：Control API Secret canary 负向扫描通过；Worker 4/4，含并发的人主体／项目主体／缺失 userid 三条路径、两名有效成员触发／恢复各一次、同人去重、限频重试；全量日志 Secret 扫描 0 命中。
- 风险：真实 CorpID／AgentID／Secret、应用可见范围与试点 `userid` 未提供，因此真实企微到达签字 PENDING_EXTERNAL。
- 结论：本地仿真闭环 PASS，真实到达门禁未伪报。
