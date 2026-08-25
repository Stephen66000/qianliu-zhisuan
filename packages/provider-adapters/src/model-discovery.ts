import { createHash } from "node:crypto";

export type ProviderCode = "deepseek" | "zhipu" | "kimi";
export type ResourceMode = "API" | "CODING_PLAN";
export type DiscoverySource =
  | "PROVIDER_API"
  | "OFFICIAL_DOCUMENTATION"
  | "LAST_SUCCESSFUL_SNAPSHOT"
  | "BUILTIN_FALLBACK"
  | "VERSIONED_CATALOG";

export interface ModelFieldEvidence {
  url: string;
  checkedAt: string;
  extractedValue: string;
}

export interface DiscoveredModelFacts {
  modalities: string[];
  protocols: string[];
  contextWindow: number | null;
  maxOutputTokens: number | null;
  reasoning: {
    required: boolean | null;
    levels: string[];
    default: string | null;
  } | null;
  clientVariants: Array<{
    protocol: string;
    model: string;
    purpose: string;
    canonicalModel: string;
  }>;
  fieldEvidence: Record<string, ModelFieldEvidence[]>;
}

export interface DiscoveredProviderModel {
  id: string;
  displayName: string;
  modelType: "CHAT" | "EMBEDDING" | "IMAGE" | "UNKNOWN";
  capabilities: string[];
  source: DiscoverySource;
  compatible: boolean;
  unavailableReason: string | null;
  facts: DiscoveredModelFacts;
}

export interface ModelDiscoveryCatalogDiff {
  added: string[];
  retained: string[];
  notAdvertised: string[];
}

export interface ModelIntegrationState {
  upstreamModel: string;
  unifiedModelExists: boolean;
  currentResourceRoute: "NONE" | "PENDING_CONFIG" | "READY" | "ACTIVE" | "DISABLED";
}

export interface ModelDiscoveryResult {
  source: DiscoverySource;
  /** 历史 API/数据库字段；新来源使用 parserVersion 作为同一稳定版本。 */
  sourceVersion: string;
  parserVersion: string | null;
  sourceUrl: string | null;
  sourceEtag: string | null;
  sourceLastModified: string | null;
  sourceContentHash: string | null;
  sourceCheckedAt: Date;
  discoveredAt: Date;
  stale: boolean;
  reused: boolean;
  models: DiscoveredProviderModel[];
  catalogDiff: ModelDiscoveryCatalogDiff | null;
  integrationStates: ModelIntegrationState[];
  failureCode?: DiscoveryErrorCode;
}

export type DiscoveryErrorCode =
  | "UNAUTHORIZED"
  | "RATE_LIMITED"
  | "UPSTREAM_UNAVAILABLE"
  | "INVALID_RESPONSE"
  | "OFFICIAL_SOURCE_UNAVAILABLE"
  | "OFFICIAL_SOURCE_UNRECOGNIZED"
  | "OFFICIAL_SOURCE_AMBIGUOUS"
  | "OFFICIAL_SOURCE_TOO_LARGE";

export class ProviderModelDiscoveryError extends Error {
  constructor(readonly code: DiscoveryErrorCode, message: string, readonly parserVersion?: string | null) {
    super(message);
    this.name = "ProviderModelDiscoveryError";
  }
}

export interface DiscoveryResponse {
  ok: boolean;
  status: number;
  headers?: Headers | Record<string, string>;
  url?: string;
  json?(): Promise<unknown>;
  text?(): Promise<string>;
}

export type DiscoveryFetch = (
  input: string,
  init: {
    method: "GET";
    headers: Record<string, string>;
    signal: AbortSignal;
    redirect: "error";
  },
) => Promise<DiscoveryResponse>;

export interface OfficialSourceConfig {
  coreUrl: string;
  supplementalUrls?: string[];
}

export type OfficialSourceOverrides = Partial<Record<`${ProviderCode}:${ResourceMode}`, Partial<OfficialSourceConfig>>>;

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
  deepseek: new Set(["api.deepseek.com"]),
  zhipu: new Set(["docs.bigmodel.cn"]),
  kimi: new Set(["www.kimi.com"]),
};

const MAX_RESPONSE_BYTES = 512 * 1024;
const MAX_HTML_DOCUMENT_BYTES = 4 * 1024 * 1024;
const MAX_MODEL_COUNT = 200;
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
  if ((providerCode === "zhipu" || providerCode === "kimi") &&
      (providerCode === "zhipu" || mode === "CODING_PLAN")) {
    const parserVersion = PARSER_VERSIONS[providerCode];
    return { source: "OFFICIAL_DOCUMENTATION", sourceVersion: parserVersion, parserVersion };
  }
  return { source: "PROVIDER_API", sourceVersion: `${providerCode}-list-models-v1`, parserVersion: null };
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
  const defaults = providerCode === "zhipu" || providerCode === "kimi"
    ? DEFAULT_OFFICIAL_SOURCES[providerCode][mode]
    : undefined;
  if (!defaults) return { coreUrl: ENDPOINTS[providerCode as "deepseek" | "kimi"] };
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
  fetch?: DiscoveryFetch;
  timeoutMs?: number;
  now?: Date;
  cacheKey?: string;
  forceRefresh?: boolean;
  officialSourceOverrides?: OfficialSourceOverrides;
  env?: NodeJS.ProcessEnv;
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

async function discoverProviderModelsUncached(input: {
  providerCode: ProviderCode;
  mode: ResourceMode;
  credential: string;
  fetch?: DiscoveryFetch;
  timeoutMs?: number;
  now?: Date;
  officialSourceOverrides?: OfficialSourceOverrides;
  env?: NodeJS.ProcessEnv;
}): Promise<ModelDiscoveryResult> {
  const now = input.now ?? new Date();
  const fetcher = input.fetch ?? (globalThis.fetch as unknown as DiscoveryFetch);
  const descriptor = providerModelDiscoveryDescriptor(input.providerCode, input.mode);
  if (descriptor.source === "OFFICIAL_DOCUMENTATION") {
    return discoverFromOfficialDocumentation(input, fetcher, now);
  }
  return discoverFromProviderApi(input, fetcher, now);
}

async function discoverFromProviderApi(
  input: { providerCode: ProviderCode; mode: ResourceMode; credential: string; timeoutMs?: number },
  fetcher: DiscoveryFetch,
  now: Date,
): Promise<ModelDiscoveryResult> {
  const sourceUrl = ENDPOINTS[input.providerCode as "deepseek" | "kimi"];
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
    models: ids.map((id) => normalizeModel(id, "PROVIDER_API", null, now)),
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

interface FetchedDocument {
  url: string;
  text: string;
  contentHash: string;
  etag: string | null;
  lastModified: string | null;
}

async function fetchDocument(fetcher: DiscoveryFetch, providerCode: ProviderCode, url: string, timeoutMs: number): Promise<FetchedDocument> {
  const response = await fetchWithTimeout(fetcher, url, {
    accept: "text/html, text/markdown, text/plain, application/json",
  }, timeoutMs, "OFFICIAL_SOURCE_UNAVAILABLE");
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

function parseOfficialDocuments(
  providerCode: ProviderCode,
  core: FetchedDocument,
  evidenceDocuments: FetchedDocument[],
  parserVersion: string,
  checkedAt: Date,
): DiscoveredProviderModel[] {
  const text = sanitizeDocument(core.text);
  const candidates = new Map<string, { displayName: string; valid: boolean; ambiguous: boolean }>();
  for (const match of text.matchAll(modelIdRegex(providerCode))) {
    const rawId = match[0];
    const id = rawId.toLowerCase();
    const start = match.index ?? 0;
    const context = text.slice(Math.max(0, start - 220), Math.min(text.length, start + rawId.length + 220));
    const explicit = /`[^`]*`|model\s*id|模型\s*(?:id|标识|代码|名称)?|型号|模型列表|models?|anthropic_default_[a-z_]*model/i.test(context);
    const ambiguous = /实验|experimental|alpha|beta|preview|历史|已下线|deprecated|对比|仅供测试/i.test(context);
    const entry = candidates.get(id) ?? { displayName: rawId, valid: false, ambiguous: false };
    entry.valid ||= explicit && !ambiguous;
    entry.ambiguous ||= ambiguous;
    candidates.set(id, entry);
  }
  if (candidates.size === 0) throw new ProviderModelDiscoveryError("OFFICIAL_SOURCE_UNRECOGNIZED", "官方页面未识别出当前解析器支持的模型 ID", parserVersion);
  const ambiguous = [...candidates.entries()].filter(([, item]) => !item.valid);
  if (ambiguous.length > 0) {
    throw new ProviderModelDiscoveryError("OFFICIAL_SOURCE_AMBIGUOUS", "官方页面中的模型 ID 语境不明确或来源冲突，未采用本次结果", parserVersion);
  }
  return [...candidates.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([id, item]) => {
    const documents = [core, ...evidenceDocuments];
    const evidenceDoc = evidenceDocuments.find((document) => document.url.toLowerCase().includes(`/${id}.`)) ?? core;
    const contexts = documents.flatMap((document) => modelContexts(document.text, id));
    const facts = extractFacts(providerCode, id, contexts.join("\n"), evidenceDoc, checkedAt);
    return normalizeModel(id, "OFFICIAL_DOCUMENTATION", facts, checkedAt, item.displayName);
  });
}

function discoverOfficialModelPageUrls(
  providerCode: ProviderCode,
  core: FetchedDocument,
  supplements: FetchedDocument[],
): string[] {
  if (providerCode !== "zhipu") return [];
  const advertised = new Set([...sanitizeDocument(core.text).matchAll(modelIdRegex(providerCode))]
    .map((match) => match[0].toLowerCase()));
  const urls = new Set<string>();
  for (const supplement of supplements) {
    for (const match of supplement.text.matchAll(/\((https:\/\/docs\.bigmodel\.cn\/[^)\s]+)\)/g)) {
      const url = match[1];
      if (!url || !/\/models\//i.test(url)) continue;
      if ([...advertised].some((id) => url.toLowerCase().endsWith(`/${id}.md`))) urls.add(url);
      if (urls.size >= 10) break;
    }
  }
  return [...urls].sort();
}

function modelIdRegex(providerCode: ProviderCode): RegExp {
  return providerCode === "zhipu"
    ? /\b(?:glm|embedding)-\d[a-z0-9._-]*\b/gi
    : /\b(?:k3(?:-256k)?|kimi-for-coding(?:-highspeed)?)\b/gi;
}

function modelContexts(text: string, id: string): string[] {
  const sanitized = sanitizeDocument(text);
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return [...sanitized.matchAll(new RegExp(`\\b${escaped}\\b`, "gi"))].map((match) => {
    const start = match.index ?? 0;
    return sanitized.slice(Math.max(0, start - 260), Math.min(sanitized.length, start + id.length + 260));
  });
}

function extractFacts(
  providerCode: ProviderCode,
  id: string,
  context: string,
  document: FetchedDocument,
  checkedAt: Date,
): DiscoveredModelFacts {
  const evidence = (value: string): ModelFieldEvidence[] => [{
    url: document.url,
    checkedAt: checkedAt.toISOString(),
    extractedValue: value,
  }];
  const contextWindow = /(?:1\s*M|1,000,000|1000000)/i.test(context) ? 1_000_000
    : /(?:256\s*K|262144)/i.test(context) ? 262_144 : null;
  const maxOutputTokens = /(?:128\s*K|128,000|128000)/i.test(context) ? 128_000 : null;
  const levels = ["low", "high", "max"].filter((level) => new RegExp(`\\b${level}\\b`, "i").test(context));
  const reasoningRequired = /始终思考|thinking\s*[:：]\s*on|reasoning/i.test(context) ? true : null;
  const reasoningDefault = /默认[^\n]{0,40}max|max[^\n]{0,40}默认/i.test(context)
    ? "max"
    : levels.includes("high") ? "high" : levels[0] ?? null;
  const fieldEvidence: Record<string, ModelFieldEvidence[]> = {};
  if (contextWindow !== null) fieldEvidence.context_window = evidence(String(contextWindow));
  if (maxOutputTokens !== null) fieldEvidence.max_output_tokens = evidence(String(maxOutputTokens));
  if (levels.length > 0) fieldEvidence.reasoning = evidence(levels.join(","));
  return {
    modalities: ["text"],
    protocols: ["OPENAI_CHAT_COMPLETIONS", "ANTHROPIC_MESSAGES"],
    contextWindow,
    maxOutputTokens,
    reasoning: reasoningRequired === null && levels.length === 0 ? null : {
      required: reasoningRequired,
      levels,
      default: reasoningDefault,
    },
    clientVariants: id === "glm-5.3" && contextWindow === 1_000_000 ? [{
      protocol: "ANTHROPIC_MESSAGES",
      model: "glm-5.3[1m]",
      purpose: "enable_1m_context",
      canonicalModel: "glm-5.3",
    }] : [],
    fieldEvidence,
  };
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
    return { modelType: "CHAT", capabilities: ["chat", "stream", "vision"], compatible: true, unavailableReason: null };
  }
  return { modelType: "CHAT", capabilities: ["chat", "stream"], compatible: true, unavailableReason: null };
}

function normalizeModel(
  id: string,
  source: DiscoverySource,
  facts: DiscoveredModelFacts | null,
  _checkedAt: Date,
  displayName = id,
): DiscoveredProviderModel {
  const classified = classifyModel(id);
  return {
    id,
    displayName,
    source,
    ...classified,
    facts: facts ?? {
      modalities: ["text"],
      protocols: ["OPENAI_CHAT_COMPLETIONS"],
      contextWindow: null,
      maxOutputTokens: null,
      reasoning: null,
      clientVariants: [],
      fieldEvidence: {},
    },
  };
}

async function fetchWithTimeout(
  fetcher: DiscoveryFetch,
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
  failureCode: "UPSTREAM_UNAVAILABLE" | "OFFICIAL_SOURCE_UNAVAILABLE",
): Promise<DiscoveryResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetcher(url, { method: "GET", headers, signal: controller.signal, redirect: "error" });
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
  if (parsed.protocol !== "https:" || !OFFICIAL_HOSTS[providerCode].has(parsed.hostname)) {
    throw new ProviderModelDiscoveryError("OFFICIAL_SOURCE_UNAVAILABLE", "官方来源 URL 不在厂商 HTTPS 白名单内");
  }
}

function sanitizeDocument(text: string): string {
  return text
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\r/g, "");
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

function cloneDiscoveryResult(result: ModelDiscoveryResult): ModelDiscoveryResult {
  return {
    ...result,
    sourceCheckedAt: new Date(result.sourceCheckedAt),
    discoveredAt: new Date(result.discoveredAt),
    models: result.models.map((model) => ({
      ...model,
      capabilities: [...model.capabilities],
      facts: {
        ...model.facts,
        modalities: [...model.facts.modalities],
        protocols: [...model.facts.protocols],
        reasoning: model.facts.reasoning ? { ...model.facts.reasoning, levels: [...model.facts.reasoning.levels] } : null,
        clientVariants: model.facts.clientVariants.map((variant) => ({ ...variant })),
        fieldEvidence: Object.fromEntries(Object.entries(model.facts.fieldEvidence).map(([key, values]) => [
          key, values.map((value) => ({ ...value })),
        ])),
      },
    })),
    catalogDiff: result.catalogDiff ? {
      added: [...result.catalogDiff.added], retained: [...result.catalogDiff.retained], notAdvertised: [...result.catalogDiff.notAdvertised],
    } : null,
    integrationStates: result.integrationStates.map((state) => ({ ...state })),
  };
}
