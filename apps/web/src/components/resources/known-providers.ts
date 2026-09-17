export interface KnownProviderPreset {
  code: string;
  name: string;
  defaultBaseUrl: string;
  description: string;
}

export const COMMON_PROVIDER_PRESETS: KnownProviderPreset[] = [
  {
    code: "Qwen",
    name: "通义千问",
    defaultBaseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    description: "阿里百炼 DashScope 官方兼容接口",
  },
  {
    code: "DeepSeek",
    name: "DeepSeek",
    defaultBaseUrl: "https://api.deepseek.com",
    description: "DeepSeek 官方 API 接口",
  },
  {
    code: "MiniMax",
    name: "MiniMax",
    defaultBaseUrl: "https://api.minimax.chat/v1",
    description: "MiniMax 开放平台接口",
  },
  {
    code: "SiliconFlow",
    name: "硅基流动",
    defaultBaseUrl: "https://api.siliconflow.cn/v1",
    description: "SiliconFlow 统一推理平台",
  },
  {
    code: "OpenAI",
    name: "OpenAI",
    defaultBaseUrl: "https://api.openai.com/v1",
    description: "OpenAI 官方 API 接口",
  },
  {
    code: "Zhipu",
    name: "智谱 GLM",
    defaultBaseUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
    description: "智谱开放平台 / CodeGeeX 接口",
  },
  {
    code: "Kimi",
    name: "Kimi",
    defaultBaseUrl: "https://api.moonshot.cn/v1",
    description: "月之暗面 Moonshot 开放平台接口",
  },
];

export function findKnownProvider(input: string): KnownProviderPreset | undefined {
  if (!input) return undefined;
  const lower = input.toLowerCase().trim();
  return COMMON_PROVIDER_PRESETS.find(
    (p) => p.code.toLowerCase() === lower || p.name.toLowerCase().includes(lower) || lower.includes(p.name.toLowerCase()),
  );
}
