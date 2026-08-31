# WorkBuddy 使用教程调研

- 收集时间：2026-08-03 10:49（Asia/Shanghai）
- 调研目的：编写员工通过仟流智算 Gateway，在 Tencent WorkBuddy 中使用 DeepSeek V4、智谱 GLM-5.2、Kimi K3 的文字教程。

## 核心结论

1. WorkBuddy 支持通过可视化界面添加自定义模型，入口为“设置 → 模型”，填写 URL、API Key 与模型名即可。
2. WorkBuddy 的标准自定义模型模式会自动补全 `/chat/completions`。接入仟流智算时应填写 Base URL `https://gw.qianliuai.com/v1`，并关闭“自定义协议”。
3. 2026-08-03 使用现有有效主体 Key，只读请求 `GET https://gw.qianliuai.com/v1/models`，生产 Gateway 返回三个当前模型 ID：
   - `qianliu-deepseek`
   - `zhipu`
   - `Kimi`
4. WorkBuddy 中需要为三个模型分别建立一条配置；三条配置共用同一个 Gateway 地址和员工个人 Key。
5. 模型名称必须填写 Gateway 对外别名，不能填写上游模型名 `deepseek-v4-*`、`glm-5.2`、`k3`。实际由 Gateway 将别名映射到当前上游模型。
6. Agent 执行依赖工具调用；WorkBuddy 页面如显示能力开关，应启用 Tool Call，图片输入与推理等未做端到端验证的能力先保持默认。
7. WorkBuddy 当前提供 Ask、Plan、Craft 三种任务模式。首次连通测试应使用 Ask；重要、多步骤任务优先 Plan；明确且可恢复的执行任务使用 Craft。
8. 官方建议日常保持默认权限，并为任务选择独立工作目录；处理重要文件前备份。

## 模型选择依据

- DeepSeek 官方：V4-Pro 与 V4-Flash 均支持 OpenAI Chat Completions、工具调用和 1M 上下文；Flash 强调速度与成本效率，Pro 强调复杂推理与 Agent Coding。
- 智谱官方：GLM-5.2 面向长任务和复杂工程，支持 1M 上下文、工具调用和长程 Coding Agent；Coding Plan 官方建议把 GLM-5.2 用于复杂推理与大型工程。
- Kimi 官方：K3 是旗舰编程模型，最高支持 1M 上下文，适合长周期编程、复杂代码库与知识工作。
- 教程中的默认建议采用“日常任务优先 DeepSeek；复杂长任务使用 GLM-5.2 或 Kimi K3”。这是结合官方定位与仟流智算三类资源组合给出的使用建议，不是强制路由规则。

## 已验证的接入配置

| 配置项 | 值 |
| --- | --- |
| Provider | Custom / 自定义 |
| Base URL | `https://gw.qianliuai.com/v1` |
| API Key | 员工个人 `sk-qianliu-...` |
| DeepSeek 模型名 | `qianliu-deepseek` |
| 智谱模型名 | `zhipu` |
| Kimi 模型名 | `Kimi` |
| 自定义协议 | 关闭 |

## 来源

1. WorkBuddy 官方《模型配置》  
   https://www.workbuddy.ai/docs/zh/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/Model
2. WorkBuddy 官方《新建任务栏》  
   https://www.workbuddy.ai/docs/zh/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/Task-Bar
3. WorkBuddy 官方《Mac 系统安装指南》  
   https://www.workbuddy.ai/docs/zh/workbuddy/From-Beginner-to-Expert-Guide/Installation-Mac-Guide
4. WorkBuddy 官方《Permission Modes》  
   https://www.workbuddy.ai/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/Permission-Modes
5. DeepSeek 官方《DeepSeek V4 Preview Release》  
   https://api-docs.deepseek.com/news/news260424/
6. DeepSeek 官方《Models & Pricing》  
   https://api-docs.deepseek.com/quick_start/pricing/
7. 智谱官方《GLM-5.2》  
   https://docs.bigmodel.cn/cn/guide/models/text/glm-5.2
8. 智谱官方《Coding Plan 常见问题》  
   https://docs.bigmodel.cn/cn/coding-plan/faq
9. Kimi 官方《模型配置》  
   https://www.kimi.com/code/docs/kimi-code/models.html
10. 仟流智算生产 Gateway `GET /v1/models` 只读核验，2026-08-03。
