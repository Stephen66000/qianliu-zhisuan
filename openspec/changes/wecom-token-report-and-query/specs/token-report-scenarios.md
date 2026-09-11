# Specifications: 企业微信 Token 每日图片日报与实时交互查用量

本规范遵循 BDD 风格（Given / When / Then），明确业务规则与验收标准。

---

## 1. 企业微信回调鉴权与消息解密

### Scenario 1.1: 企微后台保存配置时的 GET 签名验证
- **GIVEN** 企业微信后台配置了自建应用的 API 接收，向系统发起 `GET /api/wecom/callback?msg_signature=...&timestamp=...&nonce=...&echostr=...`
- **WHEN** 系统的 `verifySignature` 计算 `SHA1(sort([token, timestamp, nonce, echostr]))` 与 `msg_signature` 一致
- **THEN** 系统使用 AES-256-CBC 对 `echostr` 解密并去除补位
- **AND** 接口以 HTTP 200 直接返回解密后的明文字符串给企业微信，验证成功。

### Scenario 1.2: 非法签名请求拦截
- **GIVEN** 外部调用者向 `GET /api/wecom/callback` 或 `POST /api/wecom/callback` 发起携带错误签名的请求
- **WHEN** 计算签名与请求携带的 `msg_signature` 不匹配
- **THEN** 系统拒绝处理，直接返回 HTTP 401 Unauthorized，不执行任何解密。

---

## 2. 交互式用量查询（WeCom Chatbot）

### Scenario 2.1: 员工查询“今天我用了多少token”
- **GIVEN** 已完成企业微信绑定的员工（WeCom UserID 为 `zhangsan`，关联 `Principal(id=p1)`）
- **AND** 该员工在今天内调用 Gateway 产生了 35,000 输入 Token 和 12,000 输出 Token，共计 47,000 Tokens
- **WHEN** 该员工在企业微信自建应用窗口发送消息：“我想查今天我用了多少token”
- **THEN** 系统识别出提问者为 `zhangsan`，意图为 `TODAY` 周期
- **AND** 系统在 5 秒内回复一条排版整齐的文本消息：
  - 包含用户姓名与部门；
  - 包含统计周期“今天”；
  - 包含总 Token 数（47,000）、输入/输出 Token、调用次数以及常用模型。

### Scenario 2.2: 员工查询“上一周我用了多少token”
- **GIVEN** 已绑定的员工 `zhangsan`
- **WHEN** 该员工在企业微信发送：“上一周我用了多少token” 或 “上周用量”
- **THEN** 系统识别周期为 `LAST_WEEK`（上周一 00:00:00 至上周日 23:59:59）
- **AND** 系统聚合该周期内的用量数据并格式化回复。

### Scenario 2.3: 未绑定主体的人员提问
- **GIVEN** 企业微信员工 `lisi` 在自建应用可见范围内，但尚未在系统中绑定或开通 AI 员工主体
- **WHEN** `lisi` 在窗口发送：“今天我用了多少token”
- **THEN** 系统识别到 `person_external_identity` 未找到有效映射或对应 Principal 未激活
- **AND** 系统友好回复：“未找到您当前企业微信绑定的 AI 员工主体，请联系企业管理员在仟流智算管理后台完成主体开通与关联。”

### Scenario 2.4: 管理员查询团队/全员用量
- **GIVEN** 发送者具备管理员权限
- **WHEN** 管理员发送消息：“查全员今天消耗” 或 “全公司上周token”
- **THEN** 系统识别出管理员身份及全员查询意图
- **AND** 系统返回全公司汇总指标（全员总消耗、总请求数、活跃人数及排行前列的员工）。

---

## 3. 每日 Token 消费长图看板与定时推送

### Scenario 3.1: 定时生成前一日数据看板长图
- **GIVEN** 每日 09:00 定时任务触发（上海时间）
- **WHEN** 系统统计昨天（00:00:00 ~ 23:59:59）全企业的用量数据
- **THEN** 提取指标：全员总 Token、总请求数、活跃人数、预估成本、各模型占比、成员排行 Top 10
- **AND** 渲染生成现代化科技感深色 SVG 模板，并通过转换引擎输出为高分辨率 PNG 图片 Buffer。

### Scenario 3.2: 临时素材上传与指定人推送
- **GIVEN** 已生成昨日看板 PNG Buffer
- **WHEN** 系统调用企微 `/cgi-bin/media/upload?type=image` 接口上传
- **THEN** 企微返回有效 `media_id`
- **AND** 系统调用 `/cgi-bin/message/send` 发送 `msgtype: "image"` 消息给配置的指定接收人（`WECOM_DAILY_REPORT_RECIPIENTS`）
- **AND** 同步发送一条包含核心关键数据的文字摘要，确保信息秒级触达。
