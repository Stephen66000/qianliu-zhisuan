export interface KnownProviderPreset {
  code: string;
  name: string;
  defaultBaseUrl: string;
  modelsUrl: string;
  defaultMode?: "API" | "CODING_PLAN";
}

export const KNOWN_PROVIDER_PRESETS: Record<string, KnownProviderPreset> = {
  qwen: {
    code: "Qwen",
    name: "通义千问 (阿里百炼)",
    defaultBaseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    modelsUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1/models",
  },
  deepseek: {
    code: "DeepSeek",
    name: "DeepSeek",
    defaultBaseUrl: "https://api.deepseek.com",
    modelsUrl: "https://api.deepseek.com/models",
  },
  minimax: {
    code: "MiniMax",
    name: "MiniMax (稀宇科技)",
    defaultBaseUrl: "https://api.minimax.chat/v1",
    modelsUrl: "https://api.minimax.chat/v1/models",
  },
  siliconflow: {
    code: "SiliconFlow",
    name: "硅基流动 (SiliconFlow)",
    defaultBaseUrl: "https://api.siliconflow.cn/v1",
    modelsUrl: "https://api.siliconflow.cn/v1/models",
  },
  openai: {
    code: "OpenAI",
    name: "OpenAI",
    defaultBaseUrl: "https://api.openai.com/v1",
    modelsUrl: "https://api.openai.com/v1/models",
  },
  zhipu: {
    code: "Zhipu",
    name: "智谱 GLM",
    defaultBaseUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
    modelsUrl: "https://open.bigmodel.cn/api/coding/paas/v4/models",
  },
  kimi: {
    code: "Kimi",
    name: "Kimi (月之暗面)",
    defaultBaseUrl: "https://api.moonshot.cn/v1",
    modelsUrl: "https://api.moonshot.cn/v1/models",
  },
};

export function findKnownProvider(input: string): KnownProviderPreset | undefined {
  if (!input) return undefined;
  const lower = input.toLowerCase().trim();
  if (KNOWN_PROVIDER_PRESETS[lower]) return KNOWN_PROVIDER_PRESETS[lower];
  for (const preset of Object.values(KNOWN_PROVIDER_PRESETS)) {
    if (preset.code.toLowerCase() === lower || preset.name.toLowerCase().includes(lower)) {
      return preset;
    }
  }
  return undefined;
}

export function resolveProviderModelsUrl(providerCode: string, baseUrl?: string): string {
  if (baseUrl && baseUrl.trim()) {
    const trimmed = baseUrl.trim().replace(/\/+$/, "");
    return trimmed.endsWith("/models") ? trimmed : `${trimmed}/models`;
  }
  const p = (providerCode || "").toLowerCase().trim();
  const preset = findKnownProvider(p);
  if (preset?.modelsUrl) {
    return preset.modelsUrl;
  }
  return `https://${p}.com/v1/models`;
}
