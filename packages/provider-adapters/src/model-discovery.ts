import { createHash } from "node:crypto";
import { DEEPSEEK_VERSION_URL, enrichDeepSeekVersions } from "./deepseek-model-version.js";
import {
  ProviderModelDiscoveryError,
  type DiscoveryFetch, type DiscoveryResponse, type ModelDiscoveryResult,
  type OfficialSourceConfig, type OfficialSourceOverrides, type ProviderCode, type ResourceMode,
} from "./model-discovery-contract.js";
import {
  cloneDiscoveryResult, discoverOfficialModelPageUrls, normalizeModel, parseOfficialDocuments,
  type FetchedDocument,
} from "./model-discovery-parser.js";
import { findKnownProvider, resolveProviderModelsUrl } from "./known-providers.js";
import { resolveProviderEndpoint } from "./endpoint-policy.js";
import { probeModelPermissions } from "./model-discovery-probe.js";
import type { HttpFetch } from "./openai-compatible-types.js";
import { canonicalProviderCode } from "./provider-code.js";

export * from "./model-discovery-contract.js";

const PARSER_VERSIONS = {
  zhipu: "zhipu-docs-v1",
  kimi: "kimi-code-models-v1",
} as const;

const DEFAULT_OFFICIAL_SOURCES: Record<"zhipu" | "kimi", Record<ResourceMode, OfficialSourceConfig>> = {
  zhipu: {
    API: {
      coreUrl: "https://docs.bigmodel.cn/cn/coding-plan/latest-model",
      supplementalUrls: ["https://docs.bigmodel.cn/llms.txt"],
    },
    CODING_PLAN: {
      coreUrl: "https://docs.bigmodel.cn/cn/coding-plan/latest-model",
      supplementalUrls: ["https://docs.bigmodel.cn/llms.txt"],
    },
  },
  kimi: {
    API: {
      coreUrl: "https://api.moonshot.cn/v1/models",
    },
    CODING_PLAN: {
      coreUrl: "https://www.kimi.com/code/docs/kimi-code/models.html",
    },
  },
};

const OFFICIAL_HOSTS: Record<ProviderCode, ReadonlySet<string>> = {
  deepseek: new Set(["api.deepseek.com", "api-docs.deepseek.com"]),
  zhipu: new Set(["docs.bigmodel.cn"]),
  kimi: new Set(["www.kimi.com"]),
};

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_HTML_DOCUMENT_BYTES = 4 * 1024 * 1024;
const MAX_MODEL_COUNT = 1000;
const DEFAULT_TIMEOUT_MS = 10_000;
const CACHE_TTL_MS = 60_000;

const ZHIPU_CATALOG: Record<ResourceMode, string[]> = {
  API: ["glm-5.2", "glm-4.7", "glm-4.6", "embedding-3"],
  CODING_PLAN: ["glm-5.2", "glm-4.7", "glm-4.6"],
};
const KIMI_CODING_PLAN_CATALOG = ["k3", "k3-256k", "kimi-for-coding", "kimi-for-coding-highspeed"];

const resultCache = new Map<string, { expiresAt: number; result: ModelDiscoveryResult }>();
const inFlight = new Map<string, Promise<ModelDiscoveryResult>>();

// F-P2-11：cacheKey 含凭证指纹（高基数），无淘汰机制时每次换 Key 永久新增
// 缓存项，长跑内存单调增长。两表均做 FIFO 淘汰（TTL 60s 内 200 项远超
// 并发检测需求，命中语义不受影响）。
const MAX_CACHE_ENTRIES = 200;

function evictOldest(map: Map<string, unknown>): void {
  while (map.size >= MAX_CACHE_ENTRIES) {
    const oldest = map.keys().next();
    if (oldest.done) break;
    map.delete(oldest.value);
  }
}

export function clearProviderModelDiscoveryCache(): void {
  resultCache.clear();
  inFlight.clear();
}

export function providerModelDiscoveryDescriptor(
  providerCode: ProviderCode,
  mode: ResourceMode,
): Pick<ModelDiscoveryResult, "source" | "sourceVersion" | "parserVersion"> {
  // WP02：进入 Adapter 前统一规范化，禁止 Kimi/kimi 大小写导致分支失效。
  const p = canonicalProviderCode(providerCode);
  if ((p === "zhipu" || p === "kimi") &&
      (p === "zhipu" || mode === "CODING_PLAN")) {
    const parserVersion = PARSER_VERSIONS[p as "zhipu" | "kimi"];
    return { source: "OFFICIAL_DOCUMENTATION", sourceVersion: parserVersion, parserVersion };
  }
  return { source: "PROVIDER_API", sourceVersion: `${p}-list-models-${p === "deepseek" ? "v2" : "v1"}`, parserVersion: null };
}

export function builtinProviderModelDiscovery(input: {
  providerCode: ProviderCode;
  mode: ResourceMode;
  now?: Date;
}): ModelDiscoveryResult | null {
  const providerCode = canonicalProviderCode(input.providerCode);
  const ids = providerCode === "zhipu"
    ? ZHIPU_CATALOG[input.mode]
    : providerCode === "kimi" && input.mode === "CODING_PLAN"
      ? KIMI_CODING_PLAN_CATALOG
      : null;
  if (!ids) return null;
  const now = input.now ?? new Date();
  return {
    source: "BUILTIN_FALLBACK",
    sourceVersion: `builtin-${providerCode}-${input.mode.toLowerCase()}-v1`,
    parserVersion: null,
    sourceUrl: null,
    sourceEtag: null,
    sourceLastModified: null,
    sourceContentHash: null,
    sourceCheckedAt: now,
    discoveredAt: now,
    stale: true,
    reused: false,
    models: ids.map((id) => normalizeModel(id, "BUILTIN_FALLBACK", null, now)),
    catalogDiff: null,
    integrationStates: [],
  };
}

export function officialSourceConfig(
  providerCode: ProviderCode,
  mode: ResourceMode,
  overrides: OfficialSourceOverrides = {},
  env: NodeJS.ProcessEnv = process.env,
): OfficialSourceConfig {
  const key = `${providerCode}:${mode}` as const;
  // WP02：规范化后再匹配内置回退与 envPrefix，Zhipu/Kimi 大写不再误配。
  const p = canonicalProviderCode(providerCode);
  const defaults = (p === "zhipu" || p === "kimi")
    ? DEFAULT_OFFICIAL_SOURCES[p as "zhipu" | "kimi"][mode]
    : undefined;
  if (!defaults) {
    // F-P2-5：无官方文档来源的厂商（如 DeepSeek）同样经端点策略取发现地址，
    // 与 PROVIDER_API 链路口径一致；策略无法解析时保留既有猜测兜底。
    const viaPolicy = resolveProviderModelsEndpoint({ providerCode: p, mode, env });
    return { coreUrl: viaPolicy.ok ? viaPolicy.url : resolveProviderModelsUrl(p) };
  }
  const envPrefix = p === "zhipu"
    ? `QIANLIU_ZHIPU_${mode === "CODING_PLAN" ? "CODING_PLAN" : "API"}`
    : "QIANLIU_KIMI_CODING_PLAN";
  const envCore = env[`${envPrefix}_CORE_URL`];
  const envSupplement = env[`${envPrefix}_LLMS_URL`];
  const configured = overrides[key] ?? {};
  return {
    coreUrl: configured.coreUrl ?? envCore ?? defaults.coreUrl,
    supplementalUrls: configured.supplementalUrls
      ?? (envSupplement ? [envSupplement] : defaults.supplementalUrls),
  };
}

export async function discoverProviderModels(input: {
  providerCode: ProviderCode;
  mode: ResourceMode;
  credential: string;
  baseUrl?: string;
  /** P2：capability_set.endpoints 模式专属地址，与 baseUrl 一并进入端点策略。 */
  endpoints?: Partial<Record<ResourceMode, string>>;
  fetch?: DiscoveryFetch;
  timeoutMs?: number;
  now?: Date;
  cacheKey?: string;
  forceRefresh?: boolean;
  officialSourceOverrides?: OfficialSourceOverrides;
  env?: NodeJS.ProcessEnv;
  probePermissions?: boolean;
}): Promise<ModelDiscoveryResult> {
  const cacheKey = input.cacheKey;
  if (cacheKey && !input.forceRefresh) {
    const cached = resultCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cloneDiscoveryResult({ ...cached.result, reused: true });
    }
    const pending = inFlight.get(cacheKey);
    if (pending) return cloneDiscoveryResult({ ...(await pending), reused: true });
  }
  const work = discoverProviderModelsUncached(input);
  if (!cacheKey) return work;
  evictOldest(inFlight);
  inFlight.set(cacheKey, work);
  try {
    const result = await work;
    evictOldest(resultCache);
    resultCache.set(cacheKey, { expiresAt: Date.now() + CACHE_TTL_MS, result });
    return result;
  } finally {
    inFlight.delete(cacheKey);
  }
}

/**
 * F-P2-5：模型发现来源 URL 统一经端点策略（MODEL_DISCOVERY_SOURCE）解析，
 * 不再各处手拼 legacy baseUrl——发现链路与探针/验证/恢复/Gateway 口径一致，
 * 策略枚举的 MODEL_DISCOVERY_SOURCE operation 自此有真实消费者。
 */
export function resolveProviderModelsEndpoint(input: {
  providerCode: string;
  mode: ResourceMode;
  baseUrl?: string;
  endpoints?: Partial<Record<ResourceMode, string>>;
  env?: NodeJS.ProcessEnv;
}): { ok: true; url: string; scope: string; host: string } | { ok: false } {
  const resolved = resolveProviderEndpoint({
    providerCode: input.providerCode,
    resourceMode: input.mode,
    operation: "MODEL_DISCOVERY_SOURCE",
    configuredEndpoints: { base_url: input.baseUrl ?? null, endpoints: input.endpoints ?? null },
    env: input.env,
  });
  if (!resolved.ok) return { ok: false };
  const trimmed = resolved.url.trim().replace(/\/+$/, "");
  const url = trimmed.endsWith("/models") ? trimmed : `${trimmed}/models`;
  return { ok: true, url, scope: resolved.scope, host: resolved.host };
}

async function discoverProviderModelsUncached(rawInput: {
  providerCode: ProviderCode;
  mode: ResourceMode;
  credential: string;
  baseUrl?: string;
  endpoints?: Partial<Record<ResourceMode, string>>;
  fetch?: DiscoveryFetch;
  timeoutMs?: number;
  now?: Date;
  officialSourceOverrides?: OfficialSourceOverrides;
  env?: NodeJS.ProcessEnv;
  probePermissions?: boolean;
}): Promise<ModelDiscoveryResult> {
  // P3：规范化产出新对象，不再改写调用方入参（历史直接 input.providerCode=
  // 赋值会突变调用方对象）。
  const input = { ...rawInput, providerCode: canonicalProviderCode(rawInput.providerCode) };
  const now = input.now ?? new Date();
  // WP02：所有下游（Parser/Descriptor/探针/端点策略）只接收 canonical code。
  const fetcher = input.fetch ?? (globalThis.fetch as unknown as DiscoveryFetch);
  const descriptor = providerModelDiscoveryDescriptor(input.providerCode, input.mode);
  let result: ModelDiscoveryResult;
  if (descriptor.source === "OFFICIAL_DOCUMENTATION") {
    result = await discoverFromOfficialDocumentation(input, fetcher, now);
  } else {
    result = await discoverFromProviderApi(input, fetcher, now);
  }
  if (input.probePermissions && input.credential && result.models.length > 0) {
    await probeModelPermissions(
      input.providerCode,
      input.mode,
      input.credential,
      result.models,
      input.fetch ? (input.fetch as unknown as HttpFetch) : undefined,
      input.env,
      input.baseUrl,
      input.endpoints,
    );
  }
  return result;
}

async function discoverFromProviderApi(
  input: {
    providerCode: ProviderCode; mode: ResourceMode; credential: string; timeoutMs?: number;
    baseUrl?: string; endpoints?: Partial<Record<ResourceMode, string>>; env?: NodeJS.ProcessEnv;
  },
  fetcher: DiscoveryFetch,
  now: Date,
): Promise<ModelDiscoveryResult> {
  // F-P2-5：发现来源 URL 经端点策略解析（MODEL_DISCOVERY_SOURCE），不再直接
  // 消费 legacy baseUrl 拼 /models；策略判歧义时失败关闭。
  const modelsEndpoint = resolveProviderModelsEndpoint({
    providerCode: input.providerCode, mode: input.mode,
    baseUrl: input.baseUrl, endpoints: input.endpoints, env: input.env,
  });
  if (!modelsEndpoint.ok) {
    throw new ProviderModelDiscoveryError("OFFICIAL_SOURCE_AMBIGUOUS",
      "模型发现端点归属歧义，请在 capability 中配置模式专属地址");
  }
  const sourceUrl = modelsEndpoint.url;
  const response = await fetchWithTimeout(fetcher, sourceUrl, {
    authorization: `Bearer ${input.credential}`,
    accept: "application/json",
  }, input.timeoutMs ?? DEFAULT_TIMEOUT_MS, "UPSTREAM_UNAVAILABLE");
  if (response.status === 401 || response.status === 403) {
    throw new ProviderModelDiscoveryError("UNAUTHORIZED", "厂商拒绝当前凭证，请检查权限或有效期");
  }
  if (response.status === 429) {
    throw new ProviderModelDiscoveryError("RATE_LIMITED", "厂商模型列表请求过于频繁，请稍后重试");
  }
  if (!response.ok) {
    throw new ProviderModelDiscoveryError("UPSTREAM_UNAVAILABLE", "厂商模型列表暂时不可用");
  }
  const length = Number(getHeader(response.headers, "content-length") ?? "0");
  if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) {
    throw new ProviderModelDiscoveryError("OFFICIAL_SOURCE_TOO_LARGE", "厂商模型目录超过安全读取大小");
  }
  const payload = await readJson(response);
  const data = payload && typeof payload === "object" && Array.isArray((payload as { data?: unknown }).data)
    ? (payload as { data: unknown[] }).data
    : null;
  if (!data) throw new ProviderModelDiscoveryError("INVALID_RESPONSE", "厂商返回了无法识别的模型列表");
  let ids = [...new Set(data.map((item) => item && typeof item === "object" &&
    typeof (item as { id?: unknown }).id === "string" ? (item as { id: string }).id.trim() : "").filter(Boolean))].sort();

  const p = (input.providerCode || "").toLowerCase();
  if (p === "qwen" || findKnownProvider(p)?.code === "Qwen") {
    const qwenIds = ids.filter((id) => /^(qwen|qwq)/i.test(id));
    if (qwenIds.length > 0) {
      ids = qwenIds;
    }
  }

  if (ids.length === 0 || ids.length > MAX_MODEL_COUNT) {
    throw new ProviderModelDiscoveryError(ids.length > MAX_MODEL_COUNT ? "OFFICIAL_SOURCE_TOO_LARGE" : "INVALID_RESPONSE",
      "厂商返回的模型目录无法安全采用");
  }
  const serializedPayload = JSON.stringify(payload);
  if (new TextEncoder().encode(serializedPayload).byteLength > MAX_RESPONSE_BYTES) {
    throw new ProviderModelDiscoveryError("OFFICIAL_SOURCE_TOO_LARGE", "厂商模型目录超过安全读取大小");
  }
  const contentHash = hashContent(serializedPayload);
  const descriptor = providerModelDiscoveryDescriptor(input.providerCode, input.mode);
  const models = ids.map((id) => normalizeModel(id, "PROVIDER_API", null, now));
  if (input.providerCode === "deepseek") {
    const versionTimeout = Math.min(input.timeoutMs ?? DEFAULT_TIMEOUT_MS, 3_000);
    await enrichDeepSeekVersions(models, (signal) => fetchDocument(fetcher, "deepseek", DEEPSEEK_VERSION_URL,
      versionTimeout, signal), now, versionTimeout);
  }
  return {
    ...descriptor,
    sourceUrl,
    sourceEtag: getHeader(response.headers, "etag"),
    sourceLastModified: getHeader(response.headers, "last-modified"),
    sourceContentHash: contentHash,
    sourceCheckedAt: now,
    discoveredAt: now,
    stale: false,
    reused: false,
    models,
    catalogDiff: null,
    integrationStates: [],
  };
}

async function discoverFromOfficialDocumentation(
  input: {
    providerCode: ProviderCode;
    mode: ResourceMode;
    timeoutMs?: number;
    officialSourceOverrides?: OfficialSourceOverrides;
    env?: NodeJS.ProcessEnv;
  },
  fetcher: DiscoveryFetch,
  now: Date,
): Promise<ModelDiscoveryResult> {
  const config = officialSourceConfig(input.providerCode, input.mode, input.officialSourceOverrides, input.env);
  assertOfficialUrl(input.providerCode, config.coreUrl);
  const core = await fetchDocument(fetcher, input.providerCode, config.coreUrl, input.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const supplements: FetchedDocument[] = [];
  for (const url of config.supplementalUrls ?? []) {
    assertOfficialUrl(input.providerCode, url);
    try {
      supplements.push(await fetchDocument(fetcher, input.providerCode, url, input.timeoutMs ?? DEFAULT_TIMEOUT_MS));
    } catch (error) {
      if (!(error instanceof ProviderModelDiscoveryError) || error.code === "OFFICIAL_SOURCE_AMBIGUOUS") throw error;
    }
  }
  const modelPages: FetchedDocument[] = [];
  const modelPageUrls = discoverOfficialModelPageUrls(input.providerCode, core, supplements);
  for (const url of modelPageUrls) {
    try {
      modelPages.push(await fetchDocument(fetcher, input.providerCode, url, input.timeoutMs ?? DEFAULT_TIMEOUT_MS));
    } catch (error) {
      if (!(error instanceof ProviderModelDiscoveryError)) throw error;
    }
  }
  const parserVersion = PARSER_VERSIONS[input.providerCode as "zhipu" | "kimi"];
  const models = parseOfficialDocuments(input.providerCode, core, modelPages, parserVersion, now);
  const combinedHash = hashContent([
    core.contentHash,
    ...supplements.map((item) => item.contentHash),
    ...modelPages.map((item) => item.contentHash),
  ].join("\n"));
  return {
    source: "OFFICIAL_DOCUMENTATION",
    sourceVersion: parserVersion,
    parserVersion,
    sourceUrl: core.url,
    sourceEtag: core.etag,
    sourceLastModified: core.lastModified,
    sourceContentHash: combinedHash,
    sourceCheckedAt: now,
    discoveredAt: now,
    stale: false,
    reused: false,
    models,
    catalogDiff: null,
    integrationStates: [],
  };
}

async function fetchDocument(fetcher: DiscoveryFetch, providerCode: ProviderCode, url: string, timeoutMs: number, signal?: AbortSignal): Promise<FetchedDocument> {
  const response = await fetchWithTimeout(fetcher, url, {
    accept: "text/html, text/markdown, text/plain, application/json",
  }, timeoutMs, "OFFICIAL_SOURCE_UNAVAILABLE", signal);
  if (!response.ok) {
    if (response.status === 429) throw new ProviderModelDiscoveryError("RATE_LIMITED", "厂商官方来源请求过于频繁");
    if (response.status === 401 || response.status === 403) throw new ProviderModelDiscoveryError("UNAUTHORIZED", "厂商官方来源拒绝访问");
    throw new ProviderModelDiscoveryError("OFFICIAL_SOURCE_UNAVAILABLE", "厂商官方来源暂时不可用");
  }
  assertOfficialUrl(providerCode, response.url ?? url);
  const contentType = getHeader(response.headers, "content-type");
  if (contentType && !/text\/html|text\/markdown|text\/plain|application\/json/i.test(contentType)) {
    throw new ProviderModelDiscoveryError("OFFICIAL_SOURCE_UNRECOGNIZED", "官方来源 Content-Type 不在允许范围内");
  }
  const maxBytes = contentType && /text\/html/i.test(contentType)
    ? MAX_HTML_DOCUMENT_BYTES
    : MAX_RESPONSE_BYTES;
  const length = Number(getHeader(response.headers, "content-length") ?? "0");
  if (Number.isFinite(length) && length > maxBytes) {
    throw new ProviderModelDiscoveryError("OFFICIAL_SOURCE_TOO_LARGE", "厂商官方来源超过安全读取大小");
  }
  const text = response.text ? await response.text() : JSON.stringify(await response.json?.() ?? "");
  if (new TextEncoder().encode(text).byteLength > maxBytes) {
    throw new ProviderModelDiscoveryError("OFFICIAL_SOURCE_TOO_LARGE", "厂商官方来源超过安全读取大小");
  }
  return {
    url: response.url ?? url,
    text,
    contentHash: hashContent(text),
    etag: getHeader(response.headers, "etag"),
    lastModified: getHeader(response.headers, "last-modified"),
  };
}

async function fetchWithTimeout(
  fetcher: DiscoveryFetch,
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
  failureCode: "UPSTREAM_UNAVAILABLE" | "OFFICIAL_SOURCE_UNAVAILABLE",
  parentSignal?: AbortSignal,
): Promise<DiscoveryResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const signal = parentSignal ? AbortSignal.any([controller.signal, parentSignal]) : controller.signal;
    return await fetcher(url, { method: "GET", headers, signal, redirect: "error" });
  } catch {
    throw new ProviderModelDiscoveryError(failureCode, "官方来源超时或网络不可用");
  } finally {
    clearTimeout(timer);
  }
}

async function readJson(response: DiscoveryResponse): Promise<unknown> {
  try {
    return response.json ? await response.json() : JSON.parse(await response.text?.() ?? "");
  } catch {
    throw new ProviderModelDiscoveryError("INVALID_RESPONSE", "厂商返回了无法识别的模型列表");
  }
}

function assertOfficialUrl(providerCode: ProviderCode, rawUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new ProviderModelDiscoveryError("OFFICIAL_SOURCE_UNAVAILABLE", "官方来源 URL 无效");
  }
  const p = canonicalProviderCode(providerCode) as keyof typeof OFFICIAL_HOSTS;
  const allowed = OFFICIAL_HOSTS[p];
  if (parsed.protocol !== "https:" || !allowed?.has(parsed.hostname)) {
    throw new ProviderModelDiscoveryError("OFFICIAL_SOURCE_UNAVAILABLE", "官方来源 URL 不在厂商 HTTPS 白名单内");
  }
}

function getHeader(headers: Headers | Record<string, string> | undefined, name: string): string | null {
  if (!headers) return null;
  if (headers instanceof Headers) return headers.get(name);
  const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key ? headers[key] ?? null : null;
}

function hashContent(text: string): string {
  return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}
