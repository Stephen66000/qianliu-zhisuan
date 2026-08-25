import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";

import { post } from "../../api/client";
import { QUERY_KEYS } from "../../api/hooks";
import type { ProviderResourceItem } from "../../api/types";
import { formatDateTimeFull } from "../../lib/format";
import { INPUT_CLASS } from "../writes/FormField";

export interface DiscoveredModelItem {
  id: string;
  displayName: string;
  modelType: string;
  capabilities: string[];
  source: string;
  compatible: boolean;
  unavailableReason: string | null;
  facts?: {
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
  integration_states?: Array<{ upstream_model: string; unified_model_exists: boolean; current_resource_route: string }>;
  models: DiscoveredModelItem[];
}

interface Credentials {
  provider_id: string;
  mode: "API" | "CODING_PLAN";
  credential_plaintext: string;
}

interface CreatePanelProps {
  discovery: ModelDiscoveryResponse | null;
  getCredentials: () => Credentials;
  onDiscovery: (result: ModelDiscoveryResponse) => void;
  onSelectedModelIdsChange: (ids: string[]) => void;
  onValidationError: (message: string) => void;
  selectedModelIds: string[];
}

export function CreateModelDiscoveryPanel(props: CreatePanelProps) {
  const [search, setSearch] = useState("");
  const mutation = useMutation({
    mutationFn: (values: Credentials) =>
      post<ModelDiscoveryResponse>("/provider-resources/model-discovery", values),
    onSuccess: props.onDiscovery,
  });
  const visible = props.discovery?.models.filter((model) => {
    const query = search.trim().toLowerCase();
    return model.id.toLowerCase().includes(query) || model.displayName.toLowerCase().includes(query);
  }) ?? [];
  const detect = () => {
    const values = props.getCredentials();
    if (!values.provider_id || !values.credential_plaintext) {
      props.onValidationError("请先选择厂商并填写凭证");
      return;
    }
    mutation.mutate(values);
  };
  return <div className="sm:col-span-2 rounded-lg border border-ql-border bg-ql-surface p-3">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div><h3 className="text-[13px] font-semibold text-ql-fg">检测当前凭证可用模型</h3>
        <p className="mt-1 text-[12px] text-ql-fg-tertiary">检测只在服务端执行；不把厂商宣传页全集当作当前账号权限。</p></div>
      <button className="h-9 rounded-lg border border-ql-action px-3 text-[13px] font-medium text-ql-action disabled:opacity-60"
        disabled={mutation.isPending} onClick={detect} type="button">
        {mutation.isPending ? "检测中…" : "检测可用模型"}
      </button>
    </div>
      {props.discovery ? <div className="mt-3 space-y-2">
        <DiscoveryMeta discovery={props.discovery} />
      <div className="flex flex-wrap gap-2">
        <input aria-label="搜索发现模型" className={`${INPUT_CLASS} max-w-xs`}
          onChange={(event) => setSearch(event.target.value)} placeholder="搜索模型" value={search} />
        <button className="rounded-md px-3 text-[12px] text-ql-action"
          onClick={() => props.onSelectedModelIdsChange(
            props.discovery?.models.filter((model) => model.compatible).map((model) => model.id) ?? [],
          )} type="button">全选兼容模型</button>
        <span className="self-center text-[11px] text-ql-fg-tertiary">
          {props.discovery.source} · {formatDateTimeFull(props.discovery.discovered_at)}
        </span>
      </div>
      {visible.map((model) => <ModelChoice key={model.id} model={model}
        onChange={(checked) => props.onSelectedModelIdsChange(checked
          ? [...props.selectedModelIds, model.id]
          : props.selectedModelIds.filter((id) => id !== model.id))}
        selected={props.selectedModelIds.includes(model.id)} />)}
    </div> : null}
    {mutation.error ? <p className="mt-2 text-[12px] text-ql-danger" role="alert">{mutation.error.message}</p> : null}
  </div>;
}

function ModelChoice(props: {
  compatibleText?: string;
  model: DiscoveredModelItem;
  selected: boolean;
  onChange: (value: boolean) => void;
}) {
  return <label className="flex items-start gap-2 rounded-md border border-ql-border-zone px-3 py-2 text-[12px]">
    <input checked={props.selected} disabled={!props.model.compatible || props.model.availabilityStatus === "REMOVED"}
      onChange={(event) => props.onChange(event.target.checked)} type="checkbox" />
    <span><strong className="font-mono">{props.model.id}</strong>
      <span className="ml-2 text-ql-fg-tertiary">
        {props.model.availabilityStatus === "REMOVED"
          ? "官方本次未再列出，保留现有路由供人工复核"
          : props.model.compatible
            ? `${props.compatibleText ?? props.model.capabilities.join("、")}${formatFacts(props.model)}`
            : props.model.unavailableReason}
      </span>
    </span>
  </label>;
}

export function SyncModelsPanel({ target, onClose }: { target: ProviderResourceItem; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [discovery, setDiscovery] = useState<ModelDiscoveryResponse | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [confirmedModels, setConfirmedModels] = useState<Array<{
    alias: string;
    upstreamModel: string;
    routeId?: string;
    status: "ACTIVE" | "PENDING_CONFIG";
  }>>([]);
  const [validationResults, setValidationResults] = useState<Record<string, { status: string; errorCode: string | null }>>({});
  const sync = useMutation({
    mutationFn: () => post<ModelDiscoveryResponse>(`/provider-resources/${target.id}/models/sync`, {}),
    onSuccess: (result) => {
      setConfirmedModels([]);
      setDiscovery(result);
      setSelectedIds(result.models.filter((model) => model.compatible).map((model) => model.id));
    },
  });
  const confirm = useMutation({
    mutationFn: () => post<{ models: Array<{
      alias: string;
      upstreamModel: string;
      routeId: string;
      status: "ACTIVE" | "PENDING_CONFIG";
    }> }>(`/provider-resources/${target.id}/models/confirm`, { selected_model_ids: selectedIds }),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.providerResources });
      setConfirmedModels(result.models);
    },
  });
  const validate = useMutation({
    mutationFn: (upstreamModel: string) => post<{ validation: { status: string; errorCode: string | null } }>(
      `/provider-resources/${target.id}/models/${encodeURIComponent(upstreamModel)}/validate`,
      { idempotency_key: crypto.randomUUID(), confirm_quota_consumption: true },
    ),
    onSuccess: (result, upstreamModel) => {
      setValidationResults((current) => ({ ...current, [upstreamModel]: result.validation }));
    },
  });
  return <section className="mb-5 rounded-xl border border-ql-border bg-ql-surface-subtle p-4">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div><h2 className="text-[14px] font-semibold">同步「{target.name}」可用模型</h2>
        <p className="mt-1 text-[12px] text-ql-fg-tertiary">新模型只有确认后才创建待配置路由；不会自动加入员工 Key 或额度授权。</p></div>
      <button className="h-9 rounded-lg border border-ql-action px-3 text-[13px] text-ql-action disabled:opacity-60"
        disabled={sync.isPending} onClick={() => sync.mutate()} type="button">
        {sync.isPending ? "同步中…" : "立即同步"}
      </button>
    </div>
    {confirmedModels.length > 0 ? <div className="mt-3 rounded-lg border border-ql-success bg-ql-success-soft p-3 text-[12px]">
      <p className="font-medium text-ql-success">已确认加入 {confirmedModels.length} 个模型</p>
      <p className="mt-1 text-ql-fg-secondary">请先逐个执行真实验证（会消耗少量厂商额度）；验证通过后才能启用 Model Route。主体授权仍需另行配置。</p>
      <div className="mt-3 space-y-2">
        {confirmedModels.map((model) => {
          const validation = validationResults[model.upstreamModel];
          return <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-ql-border-zone bg-ql-surface px-3 py-2" key={model.routeId ?? model.upstreamModel}>
            <span><strong className="font-mono">{model.upstreamModel}</strong><span className="ml-2 text-ql-fg-tertiary">{validation?.status === "SUCCEEDED" ? "READY · 可启用" : validation?.status === "FAILED" ? `验证失败 · ${validation.errorCode ?? "未知错误"}` : "待验证"}</span></span>
            <button className="rounded-md border border-ql-action px-3 py-1.5 text-ql-action disabled:opacity-60" disabled={validate.isPending} onClick={() => validate.mutate(model.upstreamModel)} type="button">{validate.isPending ? "验证中…" : "真实验证（会消耗额度）"}</button>
          </div>;
        })}
      </div>
      <div className="mt-2 flex gap-3">
        <Link className="font-medium text-ql-action" to="/quota-rules">继续配置</Link>
        <button className="text-ql-fg-secondary" onClick={onClose} type="button">关闭</button>
      </div>
    </div> : discovery ? <div className="mt-3 space-y-2">
      <DiscoveryMeta discovery={discovery} />
      {discovery.models.map((model) => <ModelChoice compatibleText="可加入" key={model.id} model={model}
        onChange={(checked) => setSelectedIds((current) => checked
          ? [...current, model.id] : current.filter((id) => id !== model.id))}
        selected={selectedIds.includes(model.id)} />)}
      <div className="flex justify-end gap-2">
        <button className="h-9 rounded-lg border border-ql-border px-3 text-[13px]" onClick={onClose} type="button">取消</button>
        <button className="h-9 rounded-lg bg-ql-action px-3 text-[13px] text-white disabled:opacity-60"
          disabled={selectedIds.length === 0 || confirm.isPending} onClick={() => confirm.mutate()} type="button">
          {confirm.isPending ? "加入中…" : "确认加入所选模型"}
        </button>
      </div>
    </div> : null}
    {sync.error || confirm.error ? <p className="mt-2 text-[12px] text-ql-danger" role="alert">
      {(sync.error ?? confirm.error)?.message}
    </p> : null}
  </section>;
}

function DiscoveryMeta({ discovery }: { discovery: ModelDiscoveryResponse }) {
  const diff = discovery.catalog_diff;
  return <div className="rounded-md border border-ql-border-zone bg-ql-surface px-3 py-2 text-[11px] text-ql-fg-tertiary">
    <div className="flex flex-wrap gap-x-3 gap-y-1">
      <span>来源：{discovery.source}</span>
      {discovery.parser_version ? <span>解析器：{discovery.parser_version}</span> : null}
      <span>检查：{formatDateTimeFull(discovery.source_checked_at ?? discovery.discovered_at)}</span>
      {discovery.reused ? <span>复用 60 秒结果</span> : null}
      {discovery.stale ? <span className="font-medium text-ql-warning">过期/降级展示</span> : null}
    </div>
    {discovery.source_url ? <a className="mt-1 block truncate text-ql-action" href={discovery.source_url} rel="noreferrer" target="_blank">官方来源：{discovery.source_url}</a> : null}
    {discovery.failure_code ? <p className="mt-1 text-ql-danger">本次同步：{discovery.failure_code}；未采用不完整结果。</p> : null}
    {diff ? <p className="mt-1">目录变化：新增 {diff.added.length} · 保留 {diff.retained.length} · 官方未再列出 {diff.not_advertised.length}</p> : null}
  </div>;
}

function formatFacts(model: DiscoveredModelItem): string {
  const facts = model.facts;
  if (!facts) return "";
  const parts = [
    facts.contextWindow ? `${facts.contextWindow >= 1_000_000 ? "1M" : `${Math.round(facts.contextWindow / 1024)}K`} 上下文` : null,
    facts.maxOutputTokens ? `最大输出 ${Math.round(facts.maxOutputTokens / 1024)}K` : null,
    facts.reasoning?.levels.length ? facts.reasoning.levels.join("/") : null,
  ].filter((value): value is string => Boolean(value));
  return parts.length > 0 ? ` · ${parts.join(" · ")}` : "";
}
