/**
 * 资源模型发现共享类型与模型行展示（自 ResourceModelDiscovery.tsx 拆出，体量门禁 P1）。
 */
import { formatDateTimeFull } from "../../lib/format";

export interface DiscoveredModelItem {
  id: string;
  displayName: string;
  modelType: string;
  capabilities: string[];
  source: string;
  compatible: boolean;
  unavailableReason: string | null;
  /** WP03：模型级凭证验证脱敏证据（状态/HTTP/原因/是否可重试）。 */
  credential_validation?: {
    status: string;
    http_status: number | null;
    error_code: string | null;
    retryable: boolean;
    checked_at: string;
  } | null;
  /** 只有真实就绪（READY）的模型允许确认接入。 */
  selectable?: boolean;
  facts?: {
    officialVersion?: string | null;
    modalities?: string[];
    protocols?: string[];
    contextWindow?: number | null;
    maxOutputTokens?: number | null;
    reasoning?: { required: boolean | null; levels: string[]; default: string | null } | null;
    clientVariants?: Array<{ protocol: string; model: string; purpose: string; canonicalModel: string }>;
    fieldEvidence?: Record<string, Array<{ url: string; checkedAt: string; extractedValue: string }>>;
  };
  availabilityStatus?: "AVAILABLE" | "REMOVED";
}

export interface ModelDiscoveryResponse {
  source: string;
  source_version: string;
  parser_version?: string | null;
  source_url?: string | null;
  source_etag?: string | null;
  source_last_modified?: string | null;
  source_content_hash?: string | null;
  source_checked_at?: string;
  discovered_at: string;
  stale?: boolean;
  reused?: boolean;
  failure_code?: string;
  catalog_diff?: { added: string[]; retained: string[]; not_advertised: string[] } | null;
  summary?: { discovered: number; gateway_supported: number; credential_ready: number; credential_failed: number };
  integration_states?: Array<{ upstream_model: string; unified_model_exists: boolean; current_resource_route: string }>;
  models: DiscoveredModelItem[];
}

export function isModelSelectable(model: DiscoveredModelItem): boolean {
  // P1：回退口径与列表一致——仅 READY 可选。
  return model.selectable ?? model.credential_validation?.status === "READY";
}

/** WP06：模型行状态徽标与脱敏原因（状态/HTTP/是否可重试），失败模型展示但不允许勾选。 */
export function modelStatusLine(model: DiscoveredModelItem): { text: string; tone: "ok" | "warn" | "danger" } {
  if (model.availabilityStatus === "REMOVED") {
    return { text: "官方本次未再列出，保留现有路由供人工复核", tone: "warn" };
  }
  const validation = model.credential_validation;
  if (validation) {
    const http = validation.http_status !== null ? ` · HTTP ${validation.http_status}` : "";
    const suffix = validation.retryable ? "（可重试）" : "";
    if (validation.status === "READY") {
      return { text: `凭证验证通过${http}`, tone: "ok" };
    }
    const reason = model.unavailableReason ?? validation.error_code ?? "探针未通过";
    return { text: `${reason}${http}${suffix}`, tone: validation.retryable ? "warn" : "danger" };
  }
  if (model.compatible) {
    return { text: "兼容", tone: "ok" };
  }
  return { text: model.unavailableReason ?? "不可用", tone: "danger" };
}

export const STATUS_TONE_CLASS: Record<"ok" | "warn" | "danger", string> = {
  ok: "text-ql-success",
  warn: "text-ql-warning",
  danger: "text-ql-danger",
};

export function ModelChoice(props: {
  compatibleText?: string;
  model: DiscoveredModelItem;
  selected: boolean;
  onChange: (value: boolean) => void;
}) {
  const version = props.model.facts?.officialVersion;
  const versionSource = props.model.facts?.fieldEvidence?.official_version?.[0];
  const selectable = isModelSelectable(props.model);
  const status = modelStatusLine(props.model);
  return <label className="flex items-start gap-2 rounded-md border border-ql-border-zone px-3 py-2 text-[12px]">
    <input checked={props.selected} disabled={!selectable}
      onChange={(event) => props.onChange(event.target.checked)} type="checkbox" />
    <span><strong className="font-mono">{props.model.id}</strong>
      <span className={`ml-2 ${STATUS_TONE_CLASS[status.tone]}`}>{status.text}</span>
      <span className="ml-2 text-ql-fg-tertiary">
        {selectable
          ? `${props.compatibleText ?? props.model.capabilities.join("、")}${formatFacts(props.model)}`
          : null}
      </span>
      {version !== undefined ? <span className="mt-1 block text-ql-fg-tertiary"
        title={versionSource ? `官方来源：${versionSource.url}；检查：${formatDateTimeFull(versionSource.checkedAt)}` : undefined}>
        官方模型版本：{version ?? "未获取"}
      </span> : null}
    </span>
  </label>;
}

export function formatFacts(model: DiscoveredModelItem): string {
  const facts = model.facts;
  if (!facts) return "";
  const parts = [
    facts.contextWindow ? `${facts.contextWindow >= 1_000_000 ? "1M" : `${Math.round(facts.contextWindow / 1024)}K`} 上下文` : null,
    facts.maxOutputTokens ? `最大输出 ${Math.round(facts.maxOutputTokens / 1024)}K` : null,
    facts.reasoning?.levels.length ? facts.reasoning.levels.join("/") : null,
  ].filter((value): value is string => Boolean(value));
  return parts.length > 0 ? ` · ${parts.join(" · ")}` : "";
}
