import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";

import { post } from "../../api/client";
import { QUERY_KEYS, useResourceRoutes, useRetireResourceRoute, useRestoreResourceRoute } from "../../api/hooks";
import type { ProviderResourceItem, ResourceRouteItem } from "../../api/types";
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
  const compatibleModels = props.discovery?.models.filter((model) => model.compatible && model.availabilityStatus !== "REMOVED") ?? [];
  const selectedCount = props.selectedModelIds.filter((id) => compatibleModels.some((m) => m.id === id)).length;
  const isAllCompatibleSelected = compatibleModels.length > 0 && selectedCount === compatibleModels.length;
  const isIndeterminate = selectedCount > 0 && !isAllCompatibleSelected;

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
      <div className="flex flex-wrap items-center justify-between gap-2">
        <input aria-label="搜索发现模型" className={`${INPUT_CLASS} max-w-xs`}
          onChange={(event) => setSearch(event.target.value)} placeholder="搜索模型" value={search} />
        <span className="self-center text-[11px] text-ql-fg-tertiary">
          {props.discovery.source} · {formatDateTimeFull(props.discovery.discovered_at)}
        </span>
      </div>

      {/* 批量选择工具条 */}
      <div className="flex flex-wrap items-center justify-between gap-2 py-2 px-3 rounded-lg border border-ql-border bg-ql-surface-subtle">
        <div className="flex items-center gap-3">
          {compatibleModels.length > 1 && (
            <label className="flex items-center gap-2 cursor-pointer text-[13px] font-medium text-ql-fg select-none hover:text-ql-action transition-colors">
              <input
                type="checkbox"
                className="h-4 w-4 rounded border-ql-border text-ql-action focus:ring-ql-action cursor-pointer"
                checked={isAllCompatibleSelected}
                ref={(el) => {
                  if (el) el.indeterminate = isIndeterminate;
                }}
                onChange={(e) => {
                  if (e.target.checked) {
                    props.onSelectedModelIdsChange(compatibleModels.map((m) => m.id));
                  } else {
                    props.onSelectedModelIdsChange([]);
                  }
                }}
              />
              <span>全选</span>
            </label>
          )}
          <span className="text-[12px] text-ql-fg-muted">
            已选 <strong className="text-ql-action font-semibold">{selectedCount}</strong> / {compatibleModels.length} 个兼容模型
          </span>
        </div>

        <div className="flex items-center gap-1.5">
          <button
            type="button"
            className="px-2.5 py-1 rounded border border-ql-border bg-ql-surface text-[12px] font-medium text-ql-action hover:bg-ql-action-soft transition-colors"
            onClick={() => props.onSelectedModelIdsChange(compatibleModels.map((m) => m.id))}
          >
            全选兼容模型
          </button>
          <button
            type="button"
            className="px-2.5 py-1 rounded border border-ql-border bg-ql-surface text-[12px] font-medium text-ql-danger hover:bg-ql-danger-soft transition-colors"
            onClick={() => props.onSelectedModelIdsChange([])}
          >
            清空选择
          </button>
          {compatibleModels.some((m) => /(-plus|-max|-turbo|-chat|-reasoner)/i.test(m.id)) && (
            <button
              type="button"
              className="px-2.5 py-1 rounded border border-ql-border bg-ql-surface text-[12px] font-medium text-ql-fg hover:bg-ql-surface-subtle transition-colors"
              onClick={() => {
                const core = compatibleModels.filter((m) => /(-plus|-max|-turbo|-chat|-reasoner)/i.test(m.id));
                props.onSelectedModelIdsChange(core.map((m) => m.id));
              }}
            >
              仅选推荐
            </button>
          )}
        </div>
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
  const version = props.model.facts?.officialVersion;
  const versionSource = props.model.facts?.fieldEvidence?.official_version?.[0];
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
      {version !== undefined ? <span className="mt-1 block text-ql-fg-tertiary"
        title={versionSource ? `官方来源：${versionSource.url}；检查：${formatDateTimeFull(versionSource.checkedAt)}` : undefined}>
        官方模型版本：{version ?? "未获取"}
      </span> : null}
    </span>
  </label>;
}

export function SyncModelsPanel({ target, onClose }: { target: ProviderResourceItem; onClose: () => void }) {
  const queryClient = useQueryClient();
  const routesQuery = useResourceRoutes(target.id, "all");
  const retire = useRetireResourceRoute(target.id);
  const restore = useRestoreResourceRoute(target.id);
  const [retireTarget, setRetireTarget] = useState<ResourceRouteItem | null>(null);
  const [restoreTarget, setRestoreTarget] = useState<ResourceRouteItem | null>(null);
  const [retireMessage, setRetireMessage] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);

  const allRoutes = routesQuery.data?.routes ?? [];
  const servingRoutes = allRoutes.filter((r) => r.status === "ACTIVE" && r.has_active_billing_rule);
  const inactiveRoutes = allRoutes.filter((r) => r.status !== "ARCHIVED" && !(r.status === "ACTIVE" && r.has_active_billing_rule));
  const archivedRoutes = allRoutes.filter((r) => r.status === "ARCHIVED");

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
      const existingServing = new Set(servingRoutes.map((r) => r.upstream_model));
      const archived = new Set(archivedRoutes.map((r) => r.upstream_model));
      const joinable = result.models.filter(
        (model) =>
          model.compatible &&
          !existingServing.has(model.id) &&
          !archived.has(model.id) &&
          model.id !== "k3-256k"
      );
      setSelectedIds(joinable.map((model) => model.id));
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
      void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.resourceRoutes(target.id) });
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

  const notAdvertised = discovery?.catalog_diff?.not_advertised ?? [];
  const servingNotAdvertised = servingRoutes
    .map((r) => r.upstream_model)
    .filter((m) => notAdvertised.includes(m));

  return <section className="mb-5 rounded-xl border border-ql-border bg-ql-surface-subtle p-4">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div>
        <h2 className="text-[14px] font-semibold">同步「{target.name}」可用模型</h2>
        <p className="mt-1 text-[12px] text-ql-fg-tertiary">查看并管理已接入模型（支持一键下架），或从厂商凭证检测同步新模型。</p>
      </div>
      <div className="flex items-center gap-2">
        <button data-write-action className="h-9 rounded-lg border border-ql-action px-3 text-[13px] font-medium text-ql-action hover:bg-ql-action-soft disabled:opacity-60"
          disabled={sync.isPending} onClick={() => sync.mutate()} type="button">
          {sync.isPending ? "同步中…" : "立即同步"}
        </button>
        <button className="h-9 rounded-lg border border-ql-border px-3 text-[13px] text-ql-fg-secondary hover:bg-ql-surface"
          onClick={onClose} type="button">
          关闭
        </button>
      </div>
    </div>

    {retireMessage ? (
      <div className="mt-3 flex items-center justify-between rounded-lg border border-ql-success bg-ql-success-soft px-3 py-2 text-[12px] text-ql-success">
        <span>{retireMessage}</span>
        <button type="button" className="text-ql-fg-tertiary hover:text-ql-fg text-[13px]" onClick={() => setRetireMessage(null)}>✕</button>
      </div>
    ) : null}

    {retireTarget ? (
      <div className="mt-3 rounded-lg border border-ql-danger bg-ql-danger-soft p-3 text-[12px] text-ql-fg" role="alert">
        <p className="font-semibold text-ql-danger">
          确认下架模型「{retireTarget.model_alias || retireTarget.upstream_model}」？
        </p>
        <p className="mt-1 text-ql-fg-secondary">
          系统将原子化执行以下清理操作：
        </p>
        <ul className="mt-1 list-disc pl-5 text-ql-fg-tertiary">
          <li>停用并归档该厂商模型路由（{retireTarget.upstream_model}）</li>
          <li>从厂商已挂载模型列表中移除</li>
          <li>自动下架所有生效的关联计价与扣减规则</li>
          <li>自动停用所有员工对此模型的规则授权</li>
          <li>若全系统无其他可用厂商路由，将同步归档统一模型</li>
        </ul>
        <div className="mt-3 flex gap-2">
          <button
            type="button"
            data-write-action
            disabled={retire.isPending}
            className="rounded-md bg-ql-danger px-3 py-1.5 text-[12px] font-medium text-white disabled:opacity-60"
            onClick={() => {
              retire.mutate(retireTarget.id, {
                onSuccess: (res) => {
                  setRetireMessage(
                    `模型「${retireTarget.model_alias || retireTarget.upstream_model}」已成功下架！已归档 ${res.archived_billing_rules} 条计价规则，停用 ${res.disabled_assignments} 个员工授权${res.unified_model_archived ? "，统一模型已同步归档" : ""}。`
                  );
                  setRetireTarget(null);
                },
              });
            }}
          >
            {retire.isPending ? "下架中…" : "确认下架"}
          </button>
          <button
            type="button"
            className="rounded-md border border-ql-border px-3 py-1.5 text-[12px]"
            onClick={() => setRetireTarget(null)}
          >
            取消
          </button>
        </div>
        {retire.error ? (
          <p className="mt-2 text-[12px] text-ql-danger">{retire.error.message}</p>
        ) : null}
      </div>
    ) : null}

    {restoreTarget ? (
      <RestoreRouteConfirm
        target={restoreTarget}
        restore={restore}
        onDone={(message) => {
          setRetireMessage(message);
          setRestoreTarget(null);
        }}
        onCancel={() => setRestoreTarget(null)}
      />
    ) : null}

    <div className="mt-3 rounded-lg border border-ql-border-zone bg-ql-surface p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-[13px] font-semibold text-ql-fg">
          正在服务模型（{servingRoutes.length} 个生效中）
        </h3>
        {archivedRoutes.length > 0 ? (
          <button
            type="button"
            className="text-[12px] text-ql-action hover:underline"
            onClick={() => setShowArchived((v) => !v)}
          >
            {showArchived ? "隐藏已下架归档模型" : `查看已下架归档模型 (${archivedRoutes.length})`}
          </button>
        ) : null}
      </div>

      {routesQuery.isLoading ? (
        <p className="mt-2 text-[12px] text-ql-fg-tertiary">正在加载挂载模型…</p>
      ) : servingRoutes.length === 0 ? (
        <p className="mt-2 text-[12px] text-ql-fg-tertiary">
          暂无正在对外服务的模型（需同时启用模型路由且配置生效计价规则）。
        </p>
      ) : (
        <div className="mt-2 space-y-2">
          {servingRoutes.map((route) => {
            const isUpstreamRemoved = notAdvertised.includes(route.upstream_model);
            const displayName = route.model_alias || route.upstream_model;
            const showUpstream = Boolean(route.upstream_model && route.upstream_model !== displayName);
            return (
              <div
                key={route.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-ql-border-zone bg-ql-surface-subtle px-3 py-2 text-[12px]"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <strong className="font-mono text-[13px] text-ql-fg">{displayName}</strong>
                  {showUpstream ? (
                    <span className="font-mono text-[11px] text-ql-fg-tertiary">
                      ({route.upstream_model})
                    </span>
                  ) : null}
                  <span className="rounded bg-ql-success-soft px-1.5 py-0.5 text-[11px] font-medium text-ql-success">
                    正常服务
                  </span>
                  {isUpstreamRemoved ? (
                    <span className="rounded bg-ql-danger-soft px-1.5 py-0.5 text-[11px] font-medium text-ql-danger">
                      官方已下架
                    </span>
                  ) : null}
                </div>
                <button
                  data-write-action
                  className="rounded-md border border-ql-danger px-2.5 py-1 text-[12px] font-medium text-ql-danger hover:bg-ql-danger-soft disabled:opacity-60"
                  disabled={retire.isPending}
                  onClick={() => {
                    setRetireTarget(route);
                    setRetireMessage(null);
                  }}
                  type="button"
                >
                  下架模型
                </button>
              </div>
            );
          })}
        </div>
      )}

      {inactiveRoutes.length > 0 ? (
        <div className="mt-3 rounded-lg border border-ql-border-zone bg-ql-surface-subtle p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h4 className="text-[13px] font-semibold text-ql-fg-secondary">
                待配置 / 历史同步模型（{inactiveRoutes.length} 个未在服务）
              </h4>
              <p className="mt-0.5 text-[11px] text-ql-fg-tertiary">
                以下模型存在于该厂商历史记录中，但未启用或缺少计价规则，当前未对外提供服务。如您不需要，可点击【下架清理】彻底移除：
              </p>
            </div>
          </div>
          <div className="mt-2 space-y-2">
            {inactiveRoutes.map((route) => {
              const isUpstreamRemoved = notAdvertised.includes(route.upstream_model);
              const displayName = route.model_alias || route.upstream_model;
              const showUpstream = Boolean(route.upstream_model && route.upstream_model !== displayName);
              return (
                <div
                  key={route.id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-ql-border-zone bg-ql-surface px-3 py-2 text-[12px]"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <strong className="font-mono text-[13px] text-ql-fg-secondary">{displayName}</strong>
                    {showUpstream ? (
                      <span className="font-mono text-[11px] text-ql-fg-tertiary">
                        ({route.upstream_model})
                      </span>
                    ) : null}
                    {route.status === "ACTIVE" ? (
                      <span
                        className="rounded bg-ql-warning-soft px-1.5 py-0.5 text-[11px] font-medium text-ql-warning"
                        title="已启用路由，但缺少生效计价规则，无法被使用主体调用"
                      >
                        待配计价
                      </span>
                    ) : (
                      <span className="rounded border border-ql-border bg-ql-surface-subtle px-1.5 py-0.5 text-[11px] font-medium text-ql-fg-tertiary">
                        未启用
                      </span>
                    )}
                    {isUpstreamRemoved ? (
                      <span className="rounded bg-ql-danger-soft px-1.5 py-0.5 text-[11px] font-medium text-ql-danger">
                        官方已下架
                      </span>
                    ) : null}
                  </div>
                  <button
                    data-write-action
                    className="rounded-md border border-ql-border px-2.5 py-1 text-[12px] font-medium text-ql-fg-secondary hover:border-ql-danger hover:text-ql-danger hover:bg-ql-danger-soft disabled:opacity-60"
                    disabled={retire.isPending}
                    onClick={() => {
                      setRetireTarget(route);
                      setRetireMessage(null);
                    }}
                    type="button"
                  >
                    下架清理
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      ) : null}

      {showArchived && archivedRoutes.length > 0 ? (
        <div className="mt-3 border-t border-ql-border-zone pt-3">
          <h4 className="text-[12px] font-medium text-ql-fg-tertiary mb-2">已下架归档模型</h4>
          <div className="space-y-1.5">
            {archivedRoutes.map((route) => {
              const displayName = route.model_alias || route.upstream_model;
              return (
                <div
                  key={route.id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-ql-surface px-3 py-1.5 text-[12px] opacity-75"
                >
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-ql-fg-tertiary line-through">{displayName}</span>
                    <span className="rounded bg-ql-border-zone px-1.5 py-0.5 text-[10px] text-ql-fg-tertiary">已下架</span>
                  </div>
                  <div className="flex items-center gap-2">
                    {route.archived_at ? (
                      <span className="text-[11px] text-ql-fg-tertiary">
                        下架于 {formatDateTimeFull(route.archived_at)}
                      </span>
                    ) : null}
                    <button
                      data-write-action
                      className="rounded-md border border-ql-border px-2.5 py-1 text-[12px] font-medium text-ql-fg-secondary hover:border-ql-action hover:text-ql-action hover:bg-ql-action-soft disabled:opacity-60"
                      disabled={restore.isPending}
                      onClick={() => {
                        setRestoreTarget(route);
                        setRetireMessage(null);
                      }}
                      type="button"
                    >
                      恢复上架
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>

    {servingNotAdvertised.length > 0 ? (
      <div className="mt-3 rounded-lg border border-ql-warning bg-ql-warning-soft p-3 text-[12px] text-ql-fg">
        <p className="font-semibold text-ql-warning">
          ⚠️ 厂商官方当前已不再列出以下模型：{servingNotAdvertised.join("、")}
        </p>
        <p className="mt-1 text-ql-fg-secondary">
          若上方列表中包含这些模型，建议点击【下架模型】进行下架，防止员工调用失败。
        </p>
      </div>
    ) : null}

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
      {(() => {
        const existingServing = new Set(servingRoutes.map((r) => r.upstream_model));
        const archived = new Set(archivedRoutes.map((r) => r.upstream_model));
        const joinable = discovery.models.filter(
          (model) =>
            model.compatible &&
            !existingServing.has(model.id) &&
            !archived.has(model.id) &&
            model.id !== "k3-256k"
        );
        if (joinable.length === 0) {
          return (
            <div className="rounded-md border border-ql-border-zone bg-ql-surface p-3 text-[12px] text-ql-fg-tertiary">
              当前所有可用模型均已接入服务中，暂无未接入的新模型。
            </div>
          );
        }
        const selectedJoinableCount = selectedIds.filter((id) => joinable.some((m) => m.id === id)).length;

        return (
          <div className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2 p-2 px-3 rounded-lg bg-ql-surface border border-ql-border-zone">
              <span className="text-[12px] text-ql-fg-muted">
                已选 <strong className="text-ql-action font-semibold">{selectedJoinableCount}</strong> / {joinable.length} 个待加入模型
              </span>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  className="px-2.5 py-1 rounded border border-ql-border bg-ql-surface text-[12px] font-medium text-ql-fg hover:bg-ql-surface-subtle"
                  onClick={() => setSelectedIds(joinable.map((m) => m.id))}
                >
                  全选
                </button>
                <button
                  type="button"
                  className="px-2.5 py-1 rounded border border-ql-border bg-ql-surface text-[12px] font-medium text-ql-danger hover:bg-ql-danger-soft"
                  onClick={() => setSelectedIds([])}
                >
                  清空选择
                </button>
              </div>
            </div>
            {joinable.map((model) => (
              <ModelChoice
                compatibleText="可加入"
                key={model.id}
                model={model}
                onChange={(checked) =>
                  setSelectedIds((current) =>
                    checked ? [...current, model.id] : current.filter((id) => id !== model.id)
                  )
                }
                selected={selectedIds.includes(model.id)}
              />
            ))}
          </div>
        );
      })()}
      <div className="flex justify-end gap-2">
        <button className="h-9 rounded-lg border border-ql-border px-3 text-[13px]" onClick={onClose} type="button">取消</button>
        <button data-write-action className="h-9 rounded-lg bg-ql-action px-3 text-[13px] text-white disabled:opacity-60"
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

function RestoreRouteConfirm({
  target,
  restore,
  onDone,
  onCancel,
}: {
  target: ResourceRouteItem;
  restore: ReturnType<typeof useRestoreResourceRoute>;
  onDone: (message: string) => void;
  onCancel: () => void;
}) {
  const displayName = target.model_alias || target.upstream_model;
  return (
    <div className="mt-3 rounded-lg border border-ql-action bg-ql-action-soft p-3 text-[12px] text-ql-fg" role="alert">
      <p className="font-semibold text-ql-action">
        确认恢复上架模型「{displayName}」？
      </p>
      <p className="mt-1 text-ql-fg-secondary">
        系统将恢复该模型路由与统一模型（若已归档），并将模型加回厂商模型清单。
      </p>
      <ul className="mt-1 list-disc pl-5 text-ql-fg-tertiary">
        <li>恢复后路由保持停用状态，需重新配置计价规则并启用后才能对外服务</li>
        <li>下架时归档的计价规则与员工授权不会自动恢复，需重新配置</li>
      </ul>
      <div className="mt-3 flex gap-2">
        <button
          type="button"
          data-write-action
          disabled={restore.isPending}
          className="rounded-md bg-ql-action px-3 py-1.5 text-[12px] font-medium text-white disabled:opacity-60"
          onClick={() => {
            restore.mutate(target.id, {
              onSuccess: () => {
                onDone(`模型「${displayName}」已恢复上架，请重新配置计价规则后启用。`);
              },
            });
          }}
        >
          {restore.isPending ? "恢复中…" : "确认恢复上架"}
        </button>
        <button
          type="button"
          className="rounded-md border border-ql-border px-3 py-1.5 text-[12px]"
          onClick={onCancel}
        >
          取消
        </button>
      </div>
      {restore.error ? (
        <p className="mt-2 text-[12px] text-ql-danger">{restore.error.message}</p>
      ) : null}
    </div>
  );
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
