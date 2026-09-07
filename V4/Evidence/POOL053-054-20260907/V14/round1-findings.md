# V1.4 代码核查第一轮发现（冻结）

- 对象：initial-lock.json，19 个新增／修改源码和测试；基线 4cea87f。
- 首尾源码锁：STABLE；本轮源码只读，无修改。
- 结论：FAIL；当前为作者会话 I0 预核查，独立子代理授权仍待用户回复，不冒充正式 I1/I2 审计。
- 依据：中央 V1.4 编码规范 §3／§7／§8／§11、代码质量审计模板；公开 Gateway 输入按高风险代码核对。
- 范围：仅 053／054 完整改动、转换、准入、响应、错误持久化和日期查询上下游。未重开全阶段／全仓业务验收。

| ID | 等级 | 位置 | 发现与复现 | 最小整改 |
| --- | --- | --- | --- | --- |
| CQA-01 | P2 | model-image-capability.ts:imageReferences | 请求外层 type=tool_use/function_call 时，整份 body 在读取 messages 前被跳过；已知纯文本 glm-5.3 的图片请求仍 fetch 1 次，未返回 model_image_unsupported | 区分协议包络／消息与内容块，只跳过真正工具调用的参数；补三协议包络和带图片消息反例 |
| CQA-02 | P2 | upstream-error-evidence.ts:50 | 英文模式禁止句点，Model glm-5.3 does not support image input 被归为 INVALID_PARAMETER | 支持带小数点的精确型号名称，不跨句误匹配；补英文正反例 |
| CQA-03 | P2 | upstream-error-diagnostic.ts:31 | image_input_unsupported 固定 param=messages，Responses 请求真实字段是 input | 按北向协议选择字段，补实际北向响应断言 |
| CQA-04 | P2 / quality gate | mutation.json | 267 个变异：161 killed、1 timeout、85 survived、20 no coverage；得分60.67%，低于本次沿用诊断模块 break80；部分保护仅测试单张图片和中文主路径 | 补重复引用、缺字段、不同图、嵌套类型、英文与中文分支的行为断言；逐项审看剩余变异；不改阈值或删核心变异 |

机械结果：Adapter 四文件语句97.55%／分支91.28%／函数100%；新增门禁100%／89.58%；日期面板100%／85.10%／90%；重复率0.67%。旧 error-evidence 分支覆盖94.20%，当前93.67%，需随 CQA-04 补测消除下降。其他旧文件覆盖未退步。

下一动作：结束本轮只读核查；Execution 在一个修复批次中处理冻结清单，再生成新锁和复验。不得把本轮 FAIL 覆盖成 PASS。独立性、功能审计和正式开审握手尚不能据作者预核查宣称完成。
