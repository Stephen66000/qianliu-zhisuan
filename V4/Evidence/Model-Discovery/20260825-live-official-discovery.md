# 智谱 GLM-5.3 本机真实官方来源发现 Evidence

时间：2026-08-25T11:16:52.030Z（19:16:52 Asia/Shanghai）

## 执行边界

- 执行位置：MacBook 隔离 worktree；
- 访问范围：智谱公开官方文档；
- 未使用厂商 Token，未发起模型生成，未消耗模型额度；
- 未访问 Mac Mini、生产数据库或生产配置。

## 来源

- 核心页：`https://docs.bigmodel.cn/cn/coding-plan/latest-model`
- 补充索引：`https://docs.bigmodel.cn/llms.txt`
- GLM-5.3 字段页：`https://docs.bigmodel.cn/cn/guide/models/text/glm-5.3.md`
- 解析器：`zhipu-docs-v1`
- 合并内容哈希：`sha256:b242ce0394d03c09275ebcfb5525ffd1d29f827952969c580726b1334711d987`

## 真实发现结果

- `glm-5.3`：兼容；
- 上下文：`1000000`；
- 最大输出：`128000`；
- 思考：必须开启；`low` / `high` / `max`，默认 `max`；
- Anthropic 客户端变体：`glm-5.3[1m]`，规范模型仍为 `glm-5.3`；
- 同页仍发现 `glm-4.7`，未删除或改名既有模型。

## 本轮真实页面修正

1. 核心 HTML 实际为 `2,337,602` bytes，原 512 KiB 门禁返回 `OFFICIAL_SOURCE_TOO_LARGE`；已改为 HTML 独立 4 MiB 上限，文本/Markdown/JSON 仍为 512 KiB。
2. 核心页面包含侧栏 `GLM in Excel（Beta）`，原宽泛 `glm-*` 匹配触发 `OFFICIAL_SOURCE_AMBIGUOUS`；已收紧智谱 Coding 模型 ID 结构，并且不直接把 `llms.txt` 的全站链接当模型结果。
3. `llms.txt` 只用于找到同域模型字段页；模型 ID 仍以核心 Coding Plan 页面为准，字段以 `glm-5.3.md` 为准。

## 回归

- Provider Adapter：12 files / 136 tests passed；
- Control API 模型发现集成：1 file / 8 tests passed；
- Provider Adapter typecheck/lint passed。

## 未完成门禁

本机未发现 `ZHIPU_CODING_TOKEN`、`ZHIPU_API_KEY`、项目 `.env` 或正在运行的本地仟流智算服务，因此真实非流式、流式和 Function Calling 生成调用尚未执行。该缺口不能用夹具结果替代，也不能据此判定可部署。
