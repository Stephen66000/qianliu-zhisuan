import { useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ShieldCheck } from "lucide-react";

import { post } from "../../api/client";
import {
  QUERY_KEYS,
  useAlerts,
  usePrincipals,
  useProviderResources,
  useProviders,
} from "../../api/hooks";
import type { AlertItem } from "../../api/types";
import { AlertDetailDrawer } from "./AlertDetailDrawer";
import { AlertFilters, AlertRow } from "./AlertTableParts";
import { monthKey, occursInMonth, relationLabels } from "./alert-presenters";

export function AlertsPanel() {
  const client = useQueryClient();
  const alertsQuery = useAlerts(true);
  const principalsQuery = usePrincipals("all");
  const resourcesQuery = useProviderResources();
  const providersQuery = useProviders();
  const [month, setMonth] = useState(() => monthKey(new Date()));
  const [principalId, setPrincipalId] = useState("");
  const [providerId, setProviderId] = useState("");
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const principalLookupFailed = Boolean(principalsQuery.error);
  const resourceLookupFailed = Boolean(resourcesQuery.error);
  const providerLookupFailed = Boolean(providersQuery.error);
  const lookupFailed =
    principalLookupFailed || resourceLookupFailed || providerLookupFailed;

  const principals = useMemo(
    () => principalsQuery.data?.principals ?? [],
    [principalsQuery.data?.principals],
  );
  const resources = useMemo(
    () => resourcesQuery.data?.resources ?? [],
    [resourcesQuery.data?.resources],
  );
  const providers = useMemo(
    () => providersQuery.data?.providers ?? [],
    [providersQuery.data?.providers],
  );
  const resourceById = useMemo(
    () => new Map(resources.map((resource) => [resource.id, resource])),
    [resources],
  );
  const providerById = useMemo(
    () => new Map(providers.map((provider) => [provider.id, provider])),
    [providers],
  );
  const principalById = useMemo(
    () => new Map(principals.map((principal) => [principal.id, principal])),
    [principals],
  );

  const allAlerts = useMemo(() => {
    const unique = new Map<string, AlertItem>();
    for (const alert of [
      ...(alertsQuery.data?.alerts ?? []),
      ...(alertsQuery.data?.history ?? []),
    ])
      unique.set(alert.id, alert);
    return [...unique.values()].sort(
      (left, right) =>
        Date.parse(right.lastSeenAt) - Date.parse(left.lastSeenAt),
    );
  }, [alertsQuery.data]);

  const visible = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase("zh-CN");
    return allAlerts.filter((alert) => {
      if (month && !occursInMonth(alert, month)) return false;
      if (principalId && alert.principalId !== principalId) return false;
      const resource = alert.resourceId
        ? resourceById.get(alert.resourceId)
        : undefined;
      if (
        providerId &&
        !resourceLookupFailed &&
        resource?.provider_id !== providerId
      )
        return false;
      if (!needle) return true;
      const provider = resource
        ? providerById.get(resource.provider_id)
        : undefined;
      const principal = alert.principalId
        ? principalById.get(alert.principalId)
        : undefined;
      return [
        alert.title,
        alert.detail,
        alert.signal,
        alert.alertKey,
        alert.aiRequestId,
        resource?.name,
        provider?.name,
        provider?.code,
        principal?.name,
      ].some((value) => value?.toLocaleLowerCase("zh-CN").includes(needle));
    });
  }, [
    allAlerts,
    month,
    principalId,
    providerId,
    search,
    resourceById,
    providerById,
    principalById,
    resourceLookupFailed,
  ]);

  const selected = selectedId
    ? (allAlerts.find((alert) => alert.id === selectedId) ?? null)
    : null;
  const labelsFor = (alert: AlertItem) => {
    const principal = alert.principalId
      ? principalById.get(alert.principalId)
      : undefined;
    const resource = alert.resourceId
      ? resourceById.get(alert.resourceId)
      : undefined;
    const provider = resource
      ? providerById.get(resource.provider_id)
      : undefined;
    return relationLabels({
      principalId: alert.principalId,
      principalName: principal?.name,
      resourceId: alert.resourceId,
      resourceName: resource?.name,
      providerName: provider?.name,
      hasResource: Boolean(resource),
      principalLookupFailed,
      resourceLookupFailed,
      providerLookupFailed,
    });
  };
  const selectedLabels = selected ? labelsFor(selected) : null;
  const disposition = useMutation({
    mutationFn: (alert: AlertItem) =>
      post("/alerts/disposition", {
        alert_key: alert.alertKey,
        status: "RESOLVED",
      }),
    onSuccess: () =>
      void client.invalidateQueries({ queryKey: QUERY_KEYS.alerts }),
  });

  if (alertsQuery.error)
    return <PanelError onRetry={() => void alertsQuery.refetch()} />;

  return (
    <>
      {lookupFailed ? (
        <div
          className="mb-4 rounded-lg bg-ql-warning-soft px-3 py-2 text-[12px] text-ql-warning"
          role="alert"
        >
          主体、资源或厂商关联信息加载失败；异常事实仍保留显示，筛选和归属信息可能不完整。
          <button
            className="ml-2 underline"
            onClick={() => {
              void principalsQuery.refetch();
              void resourcesQuery.refetch();
              void providersQuery.refetch();
            }}
            type="button"
          >
            重试关联信息
          </button>
        </div>
      ) : null}
      <AlertFilters
        month={month}
        onMonth={setMonth}
        onPrincipal={setPrincipalId}
        onProvider={setProviderId}
        onSearch={setSearch}
        principalId={principalId}
        principalDisabled={principalLookupFailed}
        principals={principals}
        providerId={providerId}
        providerDisabled={resourceLookupFailed || providerLookupFailed}
        providers={providers}
        search={search}
      />
      <div className="mb-3 flex items-center justify-between text-[12px] text-ql-fg-secondary">
        <span>共 {visible.length} 条异常</span>
        <span>“是否处理”修改后立即保存</span>
      </div>
      {alertsQuery.isLoading ? (
        <p className="py-10 text-center text-sm text-ql-fg-tertiary">
          正在加载异常…
        </p>
      ) : null}
      {!alertsQuery.isLoading && visible.length === 0 ? <Empty /> : null}
      {visible.length > 0 ? (
        <div className="overflow-x-auto rounded-xl border border-ql-border bg-ql-surface">
          <table className="w-full min-w-[960px] text-left text-[12px]">
            <thead>
              <tr className="border-b border-ql-border bg-ql-surface-subtle text-[11px] text-ql-fg-tertiary">
                <th className="p-3">发生时间</th>
                <th className="p-3">使用主体</th>
                <th className="p-3">厂商 / 资源</th>
                <th className="p-3">异常内容</th>
                <th className="p-3">是否处理</th>
                <th className="p-3">恢复情况</th>
                <th className="p-3">详情</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((alert) => {
                const labels = labelsFor(alert);
                return (
                  <AlertRow
                    alert={alert}
                    key={alert.id}
                    onHandle={() => disposition.mutate(alert)}
                    onView={() => setSelectedId(alert.id)}
                    pending={disposition.isPending}
                    principalName={labels.principalName}
                    providerName={labels.providerName}
                    resourceName={labels.resourceName}
                  />
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}
      {disposition.error ? (
        <p className="mt-3 rounded-lg bg-ql-danger-soft px-3 py-2 text-sm text-ql-danger">
          处理状态保存失败，请重试。
        </p>
      ) : null}
      {selected ? (
        <AlertDetailDrawer
          alert={selected}
          handledPending={disposition.isPending}
          onClose={() => setSelectedId(null)}
          onHandle={() => disposition.mutate(selected)}
          principalName={selectedLabels?.principalName}
          providerName={selectedLabels?.providerName}
          resourceName={selectedLabels?.resourceName}
        />
      ) : null}
    </>
  );
}

function PanelError({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="rounded-lg bg-ql-danger-soft p-3 text-sm text-ql-danger">
      加载失败。
      <button className="ml-2 underline" onClick={onRetry} type="button">
        重试
      </button>
    </div>
  );
}

function Empty() {
  return (
    <div className="flex flex-col items-center gap-2 py-12 text-sm text-ql-fg-tertiary">
      <ShieldCheck className="h-6 w-6" />
      <span>当前筛选条件下没有异常</span>
      <span className="text-[11px]">可以调整月份、主体、厂商或搜索词</span>
    </div>
  );
}
