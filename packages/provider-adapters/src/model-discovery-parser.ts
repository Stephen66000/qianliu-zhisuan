import { ProviderModelDiscoveryError, type DiscoveredModelFacts, type DiscoveredProviderModel,
  type DiscoverySource, type ModelDiscoveryResult, type ModelFieldEvidence, type ProviderCode } from "./model-discovery-contract.js";

export interface FetchedDocument {
  url: string; text: string; contentHash: string; etag: string | null; lastModified: string | null;
}

export function parseOfficialDocuments(
  providerCode: ProviderCode, core: FetchedDocument, evidenceDocuments: FetchedDocument[],
  parserVersion: string, checkedAt: Date,
): DiscoveredProviderModel[] {
  const text = sanitizeDocument(core.text);
  const candidates = new Map<string, { displayName: string; valid: boolean; ambiguous: boolean }>();
  for (const match of text.matchAll(modelIdRegex(providerCode))) {
    const rawId = match[0]; const id = rawId.toLowerCase(); const start = match.index ?? 0;
    const context = text.slice(Math.max(0, start - 220), Math.min(text.length, start + rawId.length + 220));
    const explicit = /`[^`]*`|model\s*id|模型\s*(?:id|标识|代码|名称)?|型号|模型列表|models?|anthropic_default_[a-z_]*model/i.test(context);
    const ambiguous = /实验|experimental|alpha|beta|preview|历史|已下线|deprecated|对比|仅供测试/i.test(context);
    const entry = candidates.get(id) ?? { displayName: rawId, valid: false, ambiguous: false };
    entry.valid ||= explicit && !ambiguous; entry.ambiguous ||= ambiguous; candidates.set(id, entry);
  }
  if (candidates.size === 0) {
    throw new ProviderModelDiscoveryError("OFFICIAL_SOURCE_UNRECOGNIZED", "官方页面未识别出当前解析器支持的模型 ID", parserVersion);
  }
  if ([...candidates.values()].some((item) => !item.valid)) {
    throw new ProviderModelDiscoveryError("OFFICIAL_SOURCE_AMBIGUOUS", "官方页面中的模型 ID 语境不明确或来源冲突，未采用本次结果", parserVersion);
  }
  return [...candidates.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([id, item]) => {
    const documents = [core, ...evidenceDocuments];
    const evidenceDoc = evidenceDocuments.find((document) => document.url.toLowerCase().includes(`/${id}.`)) ?? core;
    const contexts = documents.flatMap((document) => modelContexts(document.text, id));
    const facts = extractFacts(id, contexts.join("\n"), evidenceDoc, checkedAt);
    return normalizeModel(id, "OFFICIAL_DOCUMENTATION", facts, checkedAt, item.displayName);
  });
}

export function discoverOfficialModelPageUrls(
  providerCode: ProviderCode, core: FetchedDocument, supplements: FetchedDocument[],
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
  return providerCode === "zhipu" ? /\b(?:glm|embedding)-\d[a-z0-9._-]*\b/gi
    : /\b(?:k3(?:-256k)?|kimi-for-coding(?:-highspeed)?)\b/gi;
}

function modelContexts(text: string, id: string): string[] {
  const sanitized = sanitizeDocument(text); const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return [...sanitized.matchAll(new RegExp(`\\b${escaped}\\b`, "gi"))].map((match) => {
    const start = match.index ?? 0;
    return sanitized.slice(Math.max(0, start - 260), Math.min(sanitized.length, start + id.length + 260));
  });
}

function extractFacts(id: string, context: string, document: FetchedDocument, checkedAt: Date): DiscoveredModelFacts {
  const evidence = (value: string): ModelFieldEvidence[] => [{
    url: document.url, checkedAt: checkedAt.toISOString(), extractedValue: value,
  }];
  const contextWindow = /(?:1\s*M|1,000,000|1000000)/i.test(context) ? 1_000_000
    : /(?:256\s*K|262144)/i.test(context) ? 262_144 : null;
  const maxOutputTokens = /(?:128\s*K|128,000|128000)/i.test(context) ? 128_000 : null;
  const levels = ["low", "high", "max"].filter((level) => new RegExp(`\\b${level}\\b`, "i").test(context));
  const reasoningRequired = /始终思考|thinking\s*[:：]\s*on|reasoning/i.test(context) ? true : null;
  const reasoningDefault = /默认[^\n]{0,40}max|max[^\n]{0,40}默认/i.test(context) ? "max"
    : levels.includes("high") ? "high" : levels[0] ?? null;
  const fieldEvidence: Record<string, ModelFieldEvidence[]> = {};
  if (contextWindow !== null) fieldEvidence.context_window = evidence(String(contextWindow));
  if (maxOutputTokens !== null) fieldEvidence.max_output_tokens = evidence(String(maxOutputTokens));
  if (levels.length > 0) fieldEvidence.reasoning = evidence(levels.join(","));
  return {
    modalities: ["text"], protocols: ["OPENAI_CHAT_COMPLETIONS", "ANTHROPIC_MESSAGES"],
    contextWindow, maxOutputTokens,
    reasoning: reasoningRequired === null && levels.length === 0 ? null
      : { required: reasoningRequired, levels, default: reasoningDefault },
    clientVariants: id === "glm-5.3" && contextWindow === 1_000_000 ? [{
      protocol: "ANTHROPIC_MESSAGES", model: "glm-5.3[1m]", purpose: "enable_1m_context", canonicalModel: "glm-5.3",
    }] : [], fieldEvidence,
  };
}

function classifyModel(id: string): Pick<DiscoveredProviderModel, "modelType" | "compatible" | "unavailableReason" | "capabilities"> {
  const normalized = id.toLowerCase();
  if (/embed/.test(normalized)) return { modelType: "EMBEDDING", capabilities: ["embedding"], compatible: false, unavailableReason: "Gateway 暂不承载向量模型" };
  if (/(^|[-_])(image|vision-gen|tts|audio)([-_]|$)/.test(normalized)) return { modelType: "IMAGE", capabilities: [], compatible: false, unavailableReason: "Gateway 暂不承载该模型类型" };
  if (/(^|[-_])vision([-_]|$)/.test(normalized)) return { modelType: "CHAT", capabilities: ["chat", "stream", "vision"], compatible: true, unavailableReason: null };
  return { modelType: "CHAT", capabilities: ["chat", "stream"], compatible: true, unavailableReason: null };
}

export function normalizeModel(
  id: string, source: DiscoverySource, facts: DiscoveredModelFacts | null, _checkedAt: Date, displayName = id,
): DiscoveredProviderModel {
  return {
    id, displayName, source, ...classifyModel(id),
    facts: facts ?? { modalities: ["text"], protocols: ["OPENAI_CHAT_COMPLETIONS"], contextWindow: null,
      maxOutputTokens: null, reasoning: null, clientVariants: [], fieldEvidence: {} },
  };
}

function sanitizeDocument(text: string): string {
  return text.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&").replace(/\r/g, "");
}

export function cloneDiscoveryResult(result: ModelDiscoveryResult): ModelDiscoveryResult {
  return {
    ...result, sourceCheckedAt: new Date(result.sourceCheckedAt), discoveredAt: new Date(result.discoveredAt),
    models: result.models.map((model) => ({ ...model, capabilities: [...model.capabilities], facts: {
      ...model.facts, modalities: [...model.facts.modalities], protocols: [...model.facts.protocols],
      reasoning: model.facts.reasoning ? { ...model.facts.reasoning, levels: [...model.facts.reasoning.levels] } : null,
      clientVariants: model.facts.clientVariants.map((variant) => ({ ...variant })),
      fieldEvidence: Object.fromEntries(Object.entries(model.facts.fieldEvidence).map(([key, values]) =>
        [key, values.map((value) => ({ ...value }))])),
    } })),
    catalogDiff: result.catalogDiff ? { added: [...result.catalogDiff.added], retained: [...result.catalogDiff.retained],
      notAdvertised: [...result.catalogDiff.notAdvertised] } : null,
    integrationStates: result.integrationStates.map((state) => ({ ...state })),
  };
}
