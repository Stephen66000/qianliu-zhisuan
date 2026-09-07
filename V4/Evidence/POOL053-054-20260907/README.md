# POOL20-053／054 本地修复与验证

> 本文为提交前验证快照；后续提交状态以 Git 记录为准，测试与审核结论绑定文内源码锁。
2026-09-07：**本地修复完成。下文217项为初版验证；有界代码审核后修正3个边界缺陷，当前282项回归通过、增量变异97.99%。尚未提交、推送或部署。**

最新结论见 [V1.4有界代码审核报告](V14/代码审核报告.md)。初版 validation.json 保留为历史证据，当前代码以 V14/final-lock.json 为准。

- 工作树：`/Users/mac/.codex/worktrees/pool053-054/仟流智算`
- 分支：`codex/pool053-054-20260907`
- 基线：`4cea87f2e5928d7486282a934c7c6c0084f241de`
- 精确源码与构建 SHA-256：[validation.json](validation.json)。本记录不替代生产部署或真实厂商业务验收。

## 053：日期与周期刷新

- 日历选择改为查询所选当天；今日／本周／本月改为可重复点击的快捷按钮，按北京时间回到当前周期。
- 相同范围显式 refetch；概览面板切回不同范围时不复用 15 秒新鲜缓存。其他 useUsageOverview 调用者保留原默认缓存时间。
- 保留所选主体和明细下钻；后台统计、账本与数据库结构不变。
- React Query 真实缓存测试覆盖重复点击、15 秒内切回、UTC 与上海跨日、历史日期返回当前日和主体保留。
- CUA 在本地生产构建与合成 API 上完成核验：9 月 6 日 → 今日回到 9 月 7 日；重复点击后出现两次相同查询，数据时间由 13:33:57 更新为 13:34:04。请求证据见 [browser-requests.jsonl](browser-requests.jsonl)。本地 fixture 的 range 仅回显 anchor，不用于验证后台时间范围算法。
- 小视口截图目视核对快捷按钮、日期、搜索与指标排列，无新增控件溢出。未冒充生产界面已更新。

## 054：模型图片门禁与诊断

- 在真实 Gateway 授权之后、路由调度／额度预占／上游调用之前检查原始图片块，排除已确认不支持图片的具体上游模型。全部候选不支持时返回 HTTP 400、`model_image_unsupported`、“模型不支持图片”。
- 当前可核实的纯文本型号按精确 ID 收录：智谱 `glm-4.6`、`glm-4.7`、`glm-5`、`glm-5.2`、`glm-5.3`。不按厂商、模型前缀或统一别名一概禁图；发现快照默认的 modalities=text 不能当作明确的无图片能力事实。未知型号保持未知、保留图片向上游请求，由安全诊断处理上游拒绝；本次没有声称覆盖所有厂商全部型号。
- Caller 再次检查实际上游模型，并逐项核对转换前后的图片引用及数量。URL、base64、file_id 保留；无法表示的图片（如尚不支持转换的工具结果图片）返回 `image_input_unsupported`，不静默发送删图后的文本。
- 含图片的请求保留原始历史，不允许可选历史截断先删掉图片后绕过门禁；文本请求继续沿用原截断设置。
- 智谱 1210～1215 加入受控白名单；JSON 数字与字符串统一为安全字符串。通用参数错误不推断成图片不支持；明确中文图片能力错误映射为 `MODEL_IMAGE_UNSUPPORTED`，北向显示明确中文、稳定 code，诊断保留厂商 code。
- 图片格式／尺寸错误仍归消息内容错误，不错误宣称整个模型没有图片能力。工具参数中看似图片的业务 JSON 不触发门禁。
- 原始消息、图片 URL／内容、工具参数、凭证均不进入新增诊断事实；保留脱敏分类、白名单错误码与 hash。不增加数据库迁移。

## 验证结果

| 范围 | 结果 |
| --- | --- |
| Provider Adapter（门禁、引用保留、中文错误、数字错误码、既有 Caller） | 140／140 |
| Gateway（真实 PostgreSQL W08/W09、北向错误、历史截断） | 44／44 |
| Web（真实缓存刷新、概览、Dashboard、诊断页面） | 28／28 |
| Contracts | 5／5 |
| Gateway／Web／Adapter／Contracts TypeScript | PASS，见 typecheck.json |
| 修改文件 ESLint／架构／源码体积／diff check | PASS，见 static-checks.json |
| Web 生产构建 | PASS；保留已有大于 500 kB 的单块警告 |

真实数据库验证覆盖三种协议 × 流式／非流式，拦截时上游调用次数不变、Attempt／Usage／Ledger 均无新增，额度计数器不变；既有图片与文本成功路径回归通过。未调用真实厂商或生产数据库。本轮是定向修复验证，不是全仓回归、独立双审或变异测试。

初轮发现测试导入路径／模拟 HTTP 类型错误及准入函数复杂度超线，均已修正，未关闭或降低门禁。预览夹具的 favicon 404 曾导致服务退出，已修正后完成实际浏览器核验；该故障不属于业务代码。

## 官方事实依据

以下来源均于 2026-09-07 读取，错误码页通过官方 Markdown 入口核对：

- [GLM-5.3](https://docs.bigmodel.cn/cn/guide/models/text/glm-5.3)：明确仅支持文本模态。
- [GLM-4.7](https://docs.bigmodel.cn/cn/guide/models/text/glm-4.7)、[GLM-4.6](https://docs.bigmodel.cn/cn/guide/models/text/glm-4.6)、[GLM-5](https://docs.bigmodel.cn/cn/guide/models/text/glm-5)、[GLM-5.2](https://docs.bigmodel.cn/cn/guide/models/text/glm-5.2)：输入模态为文本。
- [智谱 API 错误码](https://docs.bigmodel.cn/cn/faq/api-code.md)：1210 是通用参数错误；1211 是模型不存在；1212～1215 为调用方式／缺参／参数非法／参数互斥。只有明确的图片能力错误语义才返回模型不支持图片。

日志归档说明：可读日志仅规范化行尾空白；原始输出完整保存在 `raw-logs.json.gz`，未改动测试结果。
