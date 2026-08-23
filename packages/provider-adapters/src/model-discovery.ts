export type ProviderCode = "deepseek" | "zhipu" | "kimi";
export type ResourceMode = "API" | "CODING_PLAN";

export interface DiscoveredProviderModel {
  id: string;
  displayName: string;
  modelType: "CHAT" | "EMBEDDING" | "IMAGE" | "UNKNOWN";
  capabilities: string[];
  source: "PROVIDER_API" | "VERSIONED_CATALOG";
  compatible: boolean;
  unavailableReason: string | null;
}

export interface ModelDiscoveryResult {
  source: DiscoveredProviderModel["source"];
  sourceVersion: string;
  discoveredAt: Date;
  models: DiscoveredProviderModel[];
}

export class ProviderModelDiscoveryError extends Error {
  constructor(
    readonly code: "UNAUTHORIZED" | "RATE_LIMITED" | "UPSTREAM_UNAVAILABLE" | "INVALID_RESPONSE",
    message: string,
  ) {
    super(message);
    this.name = "ProviderModelDiscoveryError";
  }
}

export type DiscoveryFetch = (
  input: string,
  init: { method: "GET"; headers: Record<string, string>; signal: AbortSignal },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

const ENDPOINTS: Record<"deepseek" | "kimi", string> = {
  deepseek: "https://api.deepseek.com/models",
  kimi: "https://api.moonshot.cn/v1/models",
};

const ZHIPU_CATALOG_VERSION = "2026-08-03";
const ZHIPU_CATALOG: Record<ResourceMode, string[]> = {
  API: ["glm-5.2", "glm-4.7", "glm-4.6", "embedding-3"],
  CODING_PLAN: ["glm-5.2", "glm-4.7", "glm-4.6"],
};

/**
 * Kimi Code 与 Kimi 开放平台是两套独立凭证和端点。Coding Plan 官方文档公开模型 ID，
 * 但未提供可供订阅 Key 调用的 List Models 契约，因此使用可审计的版本化官方目录。
 */
const KIMI_CODING_PLAN_CATALOG_VERSION = "2026-08-03";
const KIMI_CODING_PLAN_CATALOG = [
  "k3",
  "k3-256k",
  "kimi-for-coding",
  "kimi-for-coding-highspeed",
];

export function providerModelDiscoveryDescriptor(
  providerCode: ProviderCode,
  mode: ResourceMode,
): Pick<ModelDiscoveryResult, "source" | "sourceVersion"> {
  if (providerCode === "zhipu") {
    return {
      source: "VERSIONED_CATALOG",
      sourceVersion: `zhipu-${mode.toLowerCase()}-${ZHIPU_CATALOG_VERSION}`,
    };
  }
  if (providerCode === "kimi" && mode === "CODING_PLAN") {
    return {
      source: "VERSIONED_CATALOG",
      sourceVersion: `kimi-coding-plan-${KIMI_CODING_PLAN_CATALOG_VERSION}`,
    };
  }
  return { source: "PROVIDER_API", sourceVersion: `${providerCode}-list-models-v1` };
}

function classifyModel(id: string): Pick<DiscoveredProviderModel, "modelType" | "compatible" | "unavailableReason" | "capabilities"> {
  const normalized = id.toLowerCase();
  if (/embed/.test(normalized)) {
    return { modelType: "EMBEDDING", capabilities: ["embedding"], compatible: false, unavailableReason: "Gateway 暂不承载向量模型" };
  }
  if (/(^|[-_])(image|vision-gen|tts|audio)([-_]|$)/.test(normalized)) {
    return { modelType: "IMAGE", capabilities: [], compatible: false, unavailableReason: "Gateway 暂不承载该模型类型" };
  }
  if (/(^|[-_])vision([-_]|$)/.test(normalized)) {
    return {
      modelType: "CHAT",
      capabilities: ["chat", "stream", "vision"],
      compatible: true,
      unavailableReason: null,
    };
  }
  return { modelType: "CHAT", capabilities: ["chat", "stream"], compatible: true, unavailableReason: null };
}

function normalizeModel(id: string, source: DiscoveredProviderModel["source"]): DiscoveredProviderModel {
  const classified = classifyModel(id);
  return { id, displayName: id, source, ...classified };
}

export async function discoverProviderModels(input: {
  providerCode: ProviderCode;
  mode: ResourceMode;
  credential: string;
  fetch?: DiscoveryFetch;
  timeoutMs?: number;
  now?: Date;
}): Promise<ModelDiscoveryResult> {
  const descriptor = providerModelDiscoveryDescriptor(input.providerCode, input.mode);
  if (input.providerCode === "zhipu") {
    return {
      ...descriptor,
      discoveredAt: input.now ?? new Date(),
      models: ZHIPU_CATALOG[input.mode].map((id) => normalizeModel(id, "VERSIONED_CATALOG")),
    };
  }
  if (input.providerCode === "kimi" && input.mode === "CODING_PLAN") {
    return {
      ...descriptor,
      discoveredAt: input.now ?? new Date(),
      models: KIMI_CODING_PLAN_CATALOG.map((id) => normalizeModel(id, "VERSIONED_CATALOG")),
    };
  }

  const fetcher = input.fetch ?? (globalThis.fetch as unknown as DiscoveryFetch);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs ?? 10_000);
  try {
    const response = await fetcher(ENDPOINTS[input.providerCode], {
      method: "GET",
      headers: { Authorization: `Bearer ${input.credential}`, Accept: "application/json" },
      signal: controller.signal,
    });
    if (response.status === 401 || response.status === 403) {
      throw new ProviderModelDiscoveryError("UNAUTHORIZED", "厂商拒绝当前凭证，请检查权限或有效期");
    }
    if (response.status === 429) {
      throw new ProviderModelDiscoveryError("RATE_LIMITED", "厂商模型列表请求过于频繁，请稍后重试");
    }
    if (!response.ok) {
      throw new ProviderModelDiscoveryError("UPSTREAM_UNAVAILABLE", "厂商模型列表暂时不可用");
    }
    const payload = await response.json();
    const data = payload && typeof payload === "object" && Array.isArray((payload as { data?: unknown }).data)
      ? (payload as { data: unknown[] }).data
      : null;
    if (!data) throw new ProviderModelDiscoveryError("INVALID_RESPONSE", "厂商返回了无法识别的模型列表");
    const ids = [...new Set(data.map((item) =>
      item && typeof item === "object" && typeof (item as { id?: unknown }).id === "string"
        ? (item as { id: string }).id.trim()
        : "").filter(Boolean))].sort();
    if (ids.length === 0) throw new ProviderModelDiscoveryError("INVALID_RESPONSE", "厂商未返回任何可识别模型");
    return {
      ...descriptor,
      discoveredAt: input.now ?? new Date(),
      models: ids.map((id) => normalizeModel(id, "PROVIDER_API")),
    };
  } catch (cause) {
    if (cause instanceof ProviderModelDiscoveryError) throw cause;
    throw new ProviderModelDiscoveryError("UPSTREAM_UNAVAILABLE", "模型同步超时或网络不可用");
  } finally {
    clearTimeout(timer);
  }
}
