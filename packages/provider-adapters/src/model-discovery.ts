import { createHash, randomUUID } from "node:crypto";
import { DEEPSEEK_VERSION_URL, enrichDeepSeekVersions } from "./deepseek-model-version.js";
import {
  ProviderModelDiscoveryError,
  type DiscoveredProviderModel,
  type DiscoveryFetch, type DiscoveryResponse, type ModelDiscoveryResult,
  type OfficialSourceConfig, type OfficialSourceOverrides, type ProviderCode, type ResourceMode,
} from "./model-discovery-contract.js";
import {
  cloneDiscoveryResult, discoverOfficialModelPageUrls, normalizeModel, parseOfficialDocuments,
  type FetchedDocument,
} from "./model-discovery-parser.js";
import { SecretValue } from "./secret-value.js";
import { createOpenAiCompatibleCaller } from "./openai-compatible-caller.js";
import type { HttpFetch } from "./openai-compatible-types.js";

import { resolveProviderModelsUrl } from "./known-providers.js";

export * from "./model-discovery-contract.js";

const ENDPOINTS: Record<"deepseek" | "kimi", string> = {
  deepseek: "https://api.deepseek.com/models",
  kimi: "https://api.moonshot.cn/v1/models",
};

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

export function clearProviderModelDiscoveryCache(): void {
  resultCache.clear();
  inFlight.clear();
}

export function providerModelDiscoveryDescriptor(
  providerCode: ProviderCode,
  mode: ResourceMode,
): Pick<ModelDiscoveryResult, "source" | "sourceVersion" | "parserVersion"> {
  const p = (providerCode || "").toLowerCase();
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
  const ids = input.providerCode === "zhipu"
    ? ZHIPU_CATALOG[input.mode]
    : input.providerCode === "kimi" && input.mode === "CODING_PLAN"
      ? KIMI_CODING_PLAN_CATALOG
      : null;
  if (!ids) return null;
  const now = input.now ?? new Date();
  return {
    source: "BUILTIN_FALLBACK",
    sourceVersion: `builtin-${input.providerCode}-${input.mode.toLowerCase()}-v1`,
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
  const p = (providerCode || "").toLowerCase();
  const defaults = (p === "zhipu" || p === "kimi")
    ? DEFAULT_OFFICIAL_SOURCES[p as "zhipu" | "kimi"][mode]
    : undefined;
  if (!defaults) return { coreUrl: ENDPOINTS[p as "deepseek" | "kimi"] ?? resolveProviderModelsUrl(providerCode) };
  const envPrefix = providerCode === "zhipu"
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
  inFlight.set(cacheKey, work);
  try {
    const result = await work;
    resultCache.set(cacheKey, { expiresAt: Date.now() + CACHE_TTL_MS, result });
    return result;
  } finally {
    inFlight.delete(cacheKey);
  }
}

async function probeModelPermissions(
  providerCode: ProviderCode,
  mode: ResourceMode,
  credential: string,
  models: DiscoveredProviderModel[],
  fetcher?: HttpFetch,
  env: NodeJS.ProcessEnv = process.env,
  baseUrl?: string,
): Promise<void> {
  const caller = createOpenAiCompatibleCaller({
    ...(fetcher ? { fetch: fetcher } : {}),
    env,
    requestTimeoutMs: 60_000,
    firstByteTimeoutMs: 30_000,
    streamIdleTimeoutMs: 30_000,
  });
  const chatModels = models.filter((m) => m.modelType === "CHAT");
  // 若厂商模型数量较多（如 Qwen/OpenAI/SiliconFlow 包含数十甚至数百模型），
  // 全量串行探活会导致严重耗时或上游频控。探查前 5 个典型模型即可确认接口与 Key 健康度。
  const modelsToProbe = chatModels.length > 5 ? chatModels.slice(0, 5) : chatModels;
  for (const model of modelsToProbe) {
    if (providerCode === "kimi" && mode === "CODING_PLAN" && model.id === "k3-256k") {
      model.compatible = false;
      model.unavailableReason = "当前套餐未开通此模型权限 (HTTP 403)";
      continue;
    }
    const isK3 = providerCode === "kimi" && /^(?:kimi-)?k3(?:-|$)/i.test(model.id);
    try {
      const outcome = await caller({
        providerCode,
        resourceId: "probe",
        mode,
        upstreamModel: model.id,
        concurrencyLimit: 1,
        baseUrl,
        secret: new SecretValue(credential),
      }, {
        requestId: `probe-${randomUUID()}`,
        unifiedModel: model.id,
        stream: false,
        capability: "chat",
        body: {
          model: model.id,
          messages: [{ role: "user", content: "hi" }],
          ...(isK3 ? { reasoning_effort: "low" } : {}),
        },
      }, 1);
      const ok = outcome.status >= 200 && outcome.status < 300;
      if (ok) {
        model.compatible = true;
        model.unavailableReason = null;
      } else {
        if (outcome.status === 403) {
          model.compatible = false;
          model.unavailableReason = "当前套餐/凭证未开通此模型权限 (HTTP 403)";
        } else if (outcome.status === 401) {
          model.compatible = false;
          model.unavailableReason = "凭证鉴权失败 (HTTP 401)";
        } else if (outcome.status === 400 || outcome.status === 404) {
          model.compatible = false;
          model.unavailableReason = "当前套餐不支持此模型 (HTTP 404)";
        } else {
          // 对于已知基础核心模型（如 Kimi k3），非明确权限拒绝（如 5xx 或探针网络波动）不武断判定为不兼容
          if (model.id === "k3" || model.id === "kimi-for-coding" || model.id === "kimi-for-coding-highspeed") {
            model.compatible = true;
            model.unavailableReason = null;
          } else {
            model.compatible = false;
            model.unavailableReason = `模型不可用 (${outcome.upstreamCode || `HTTP_${outcome.status}`})`;
          }
        }
      }
    } catch {
      if (model.id === "k3" || model.id === "kimi-for-coding" || model.id === "kimi-for-coding-highspeed") {
        model.compatible = true;
        model.unavailableReason = null;
      } else {
        model.compatible = false;
        model.unavailableReason = "模型探活超时或连接失败";
      }
    }
  }
}

async function discoverProviderModelsUncached(input: {
  providerCode: ProviderCode;
  mode: ResourceMode;
  credential: string;
  baseUrl?: string;
  fetch?: DiscoveryFetch;
  timeoutMs?: number;
  now?: Date;
  officialSourceOverrides?: OfficialSourceOverrides;
  env?: NodeJS.ProcessEnv;
  probePermissions?: boolean;
}): Promise<ModelDiscoveryResult> {
  const now = input.now ?? new Date();
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
    );
  }
  return result;
}

async function discoverFromProviderApi(
  input: { providerCode: ProviderCode; mode: ResourceMode; credential: string; timeoutMs?: number; baseUrl?: string },
  fetcher: DiscoveryFetch,
  now: Date,
): Promise<ModelDiscoveryResult> {
  const sourceUrl = resolveProviderModelsUrl(input.providerCode, input.baseUrl);
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
  const ids = [...new Set(data.map((item) => item && typeof item === "object" &&
    typeof (item as { id?: unknown }).id === "string" ? (item as { id: string }).id.trim() : "").filter(Boolean))].sort();
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
  const p = (providerCode || "").toLowerCase() as keyof typeof OFFICIAL_HOSTS;
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
