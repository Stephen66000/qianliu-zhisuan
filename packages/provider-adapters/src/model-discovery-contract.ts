export type ProviderCode = "deepseek" | "zhipu" | "kimi" | (string & {});
export type ResourceMode = "API" | "CODING_PLAN";
export type DiscoverySource = "PROVIDER_API" | "OFFICIAL_DOCUMENTATION"
  | "LAST_SUCCESSFUL_SNAPSHOT" | "BUILTIN_FALLBACK" | "VERSIONED_CATALOG";

export interface ModelFieldEvidence { url: string; checkedAt: string; extractedValue: string }
export interface DiscoveredModelFacts {
  officialVersion?: string | null;
  modalities: string[]; protocols: string[]; contextWindow: number | null; maxOutputTokens: number | null;
  reasoning: { required: boolean | null; levels: string[]; default: string | null } | null;
  clientVariants: Array<{ protocol: string; model: string; purpose: string; canonicalModel: string }>;
  fieldEvidence: Record<string, ModelFieldEvidence[]>;
}

/** 凭证验证状态（WP03 三层事实分离：发现 ≠ Gateway 兼容 ≠ 凭证验证）。 */
export type CredentialValidationStatus =
  | "NOT_RUN" | "READY" | "AUTH_FAILED" | "PLAN_NOT_ENTITLED"
  | "REQUEST_REJECTED" | "RATE_LIMITED" | "UPSTREAM_UNAVAILABLE" | "NETWORK_FAILED";

/** 脱敏凭证验证证据：禁止包含 Key、Authorization、Prompt 或上游响应正文。 */
export interface CredentialValidationEvidence {
  status: CredentialValidationStatus;
  httpStatus: number | null;
  errorCode: string | null;
  retryable: boolean;
  checkedAt: string;
  /** F-P2-4：探针请求实际命中的解析端点（scope/host），回答"请求打到哪个 host"。 */
  endpointScope?: string | null;
  endpointHost?: string | null;
}
export interface DiscoveredProviderModel {
  id: string; displayName: string; modelType: "CHAT" | "EMBEDDING" | "IMAGE" | "UNKNOWN";
  capabilities: string[]; source: DiscoverySource; compatible: boolean; unavailableReason: string | null;
  facts: DiscoveredModelFacts;
  /** 权限探针脱敏证据；未探针（EMBEDDING 等）时为 null。 */
  credentialValidation?: CredentialValidationEvidence | null;
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
