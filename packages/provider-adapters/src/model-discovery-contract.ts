export type ProviderCode = "deepseek" | "zhipu" | "kimi";
export type ResourceMode = "API" | "CODING_PLAN";
export type DiscoverySource = "PROVIDER_API" | "OFFICIAL_DOCUMENTATION"
  | "LAST_SUCCESSFUL_SNAPSHOT" | "BUILTIN_FALLBACK" | "VERSIONED_CATALOG";

export interface ModelFieldEvidence { url: string; checkedAt: string; extractedValue: string }
export interface DiscoveredModelFacts {
  modalities: string[]; protocols: string[]; contextWindow: number | null; maxOutputTokens: number | null;
  reasoning: { required: boolean | null; levels: string[]; default: string | null } | null;
  clientVariants: Array<{ protocol: string; model: string; purpose: string; canonicalModel: string }>;
  fieldEvidence: Record<string, ModelFieldEvidence[]>;
}
export interface DiscoveredProviderModel {
  id: string; displayName: string; modelType: "CHAT" | "EMBEDDING" | "IMAGE" | "UNKNOWN";
  capabilities: string[]; source: DiscoverySource; compatible: boolean; unavailableReason: string | null;
  facts: DiscoveredModelFacts;
}
export interface ModelDiscoveryCatalogDiff { added: string[]; retained: string[]; notAdvertised: string[] }
export interface ModelIntegrationState {
  upstreamModel: string; unifiedModelExists: boolean;
  currentResourceRoute: "NONE" | "PENDING_CONFIG" | "READY" | "ACTIVE" | "DISABLED";
}
export interface ModelDiscoveryResult {
  source: DiscoverySource; sourceVersion: string; parserVersion: string | null; sourceUrl: string | null;
  sourceEtag: string | null; sourceLastModified: string | null; sourceContentHash: string | null;
  sourceCheckedAt: Date; discoveredAt: Date; stale: boolean; reused: boolean;
  models: DiscoveredProviderModel[]; catalogDiff: ModelDiscoveryCatalogDiff | null;
  integrationStates: ModelIntegrationState[]; failureCode?: DiscoveryErrorCode;
}
export type DiscoveryErrorCode = "UNAUTHORIZED" | "RATE_LIMITED" | "UPSTREAM_UNAVAILABLE"
  | "INVALID_RESPONSE" | "OFFICIAL_SOURCE_UNAVAILABLE" | "OFFICIAL_SOURCE_UNRECOGNIZED"
  | "OFFICIAL_SOURCE_AMBIGUOUS" | "OFFICIAL_SOURCE_TOO_LARGE";
export class ProviderModelDiscoveryError extends Error {
  constructor(readonly code: DiscoveryErrorCode, message: string, readonly parserVersion?: string | null) {
    super(message);
    this.name = "ProviderModelDiscoveryError";
  }
}
export interface DiscoveryResponse {
  ok: boolean; status: number; headers?: Headers | Record<string, string>; url?: string;
  json?(): Promise<unknown>; text?(): Promise<string>;
}
export type DiscoveryFetch = (input: string, init: {
  method: "GET"; headers: Record<string, string>; signal: AbortSignal; redirect: "error";
}) => Promise<DiscoveryResponse>;
export interface OfficialSourceConfig { coreUrl: string; supplementalUrls?: string[] }
export type OfficialSourceOverrides = Partial<Record<`${ProviderCode}:${ResourceMode}`, Partial<OfficialSourceConfig>>>;
