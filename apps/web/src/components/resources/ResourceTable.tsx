import { Server } from "lucide-react";
import { get } from "../../api/client";
import type { ProviderResourceItem, ProviderResourceOperatingSnapshot } from "../../api/types";
import { StatusTag } from "../dashboard/StatusTag";
import { QueryGate } from "../states/QueryGate";
import { formatDateTimeFull } from "../../lib/format";
import { resourceStatusLabel } from "../../lib/resource-status";
import { operatingDraftFromResource } from "./resource-form-contract";
import { ISOLATED, MODE_LABEL, ResourceFinanceColumn, ResourceQuotaColumn } from "./resource-page-display";
import type { ResourcesPageModel } from "../../pages/resources-page-model";

export function resourceModelNames(resource: Pick<ProviderResourceItem, "upstream_models" | "display_upstream_models">) {
  const models = resource.display_upstream_models ?? resource.upstream_models;
  return models?.length ? models.join("、") : resource.upstream_models?.length ? "暂无未存档型号" : "未声明模型";
}

export function ResourceTable({ model }: { model: ResourcesPageModel }) {
  const { query, setRecoverTarget, setEditTarget, setSyncTarget, setDeleteResourceTarget, setOperatingTarget, setOperatingDraft, setOperatingValidationError, setOperatingHistory, editReset, resources, providerOptions, showArchived, setShowArchived, archiveResourceMutation, unarchiveResourceMutation } = model;
  return <>
      <div className="mb-2 flex justify-end">
        <label className="flex cursor-pointer items-center gap-1.5 text-[12px] text-ql-fg-muted select-none">
          <input
            type="checkbox"
            className="h-3.5 w-3.5 rounded border-ql-border text-ql-action focus:ring-ql-action"
            checked={showArchived}
            onChange={(e) => setShowArchived(e.target.checked)}
          />
          显示已归档资源
        </label>
      </div>
      <QueryGate
        emptyDescription="尚未登记可用 AI 资源，无法产生模型和路由候选。点击右上角「登记资源」登记 DeepSeek API、智谱或 Kimi 资源。"
        emptyIcon={Server}
        emptyTitle="尚未登记厂商资源"
        error={query.error}
        isEmpty={resources.length === 0}
        isLoading={query.isLoading}
        loadingRows={4}
        onRetry={() => void query.refetch()}
      >
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1120px] table-fixed border-collapse text-left">
            <colgroup>
              <col className="w-[8%]" /><col className="w-[14%]" /><col className="w-[5%]" />
              <col className="w-[14%]" /><col className="w-[15%]" /><col className="w-[12%]" />
              <col className="w-[7%]" /><col className="w-[10%]" /><col className="w-[15%]" />
            </colgroup>
            <thead>
              <tr className="border-b border-ql-border text-[12px] leading-[18px] text-ql-fg-tertiary">
                <th className="py-2 pr-4 font-medium">名称</th>
                <th className="py-2 pr-4 font-medium">厂商/模型</th>
                <th className="py-2 pr-4 font-medium">模式</th>
                <th className="py-2 pr-4 font-medium">资金</th>
                <th className="py-2 pr-4 font-medium">额度数据</th>
                <th className="py-2 pr-4 font-medium">数据时间</th>
                <th className="py-2 pr-4 font-medium">状态</th>
                <th className="py-2 pr-4 font-medium">创建时间</th>
                <th className="py-2 text-right font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {resources.map((r) => (
                <tr
                  className="border-b border-ql-border-zone text-[13px] leading-5 text-ql-fg last:border-b-0 hover:bg-ql-surface-subtle"
                  key={r.id}
                >
                  <td className="py-2.5 pr-4 font-medium">
                    {r.name}
                    {r.archived_at ? (
                      <span className="ml-1.5 rounded bg-ql-surface-subtle border border-ql-border px-1.5 py-0.5 text-[10px] font-normal text-ql-fg-muted">已归档</span>
                    ) : null}
                  </td>
                  <td className="py-2.5 pr-4 text-ql-fg-secondary">
                    <span className="block">
                      {providerOptions.find((provider) => provider.id === r.provider_id)?.name ?? "—"}
                    </span>
                    <span className="font-mono text-[11px] text-ql-fg-tertiary">
                      {resourceModelNames(r)}
                    </span>
                  </td>
                  <td className="py-2.5 pr-4 text-ql-fg-secondary">{MODE_LABEL[r.mode]}</td>
                  <td className="break-words py-2.5 pr-4 text-ql-fg-secondary">
                    <ResourceFinanceColumn resource={r} />
                  </td>
                  <td className="break-words py-2.5 pr-4 text-ql-fg-secondary">
                    <ResourceQuotaColumn resource={r} />
                  </td>
                  <td
                    className="break-words py-2.5 pr-4 align-top text-ql-fg-secondary"
                    title={r.operating_sync ? [
                      r.operating_sync.data_status,
                      `余额 ${r.operating_sync.balance_status}`,
                      `费用 ${r.operating_sync.cost_status}`,
                      r.operating_sync.failure_reason,
                    ].filter(Boolean).join(" · ") : undefined}
                  >
                    <span className="block leading-5">
                      {r.operating_snapshot
                        ? <><span className="block">v{r.operating_snapshot.version}</span><span className="block whitespace-nowrap">{formatDateTimeFull(
                          r.operating_snapshot.balance_updated_at
                            ?? r.operating_snapshot.calculated_at
                            ?? r.operating_snapshot.collected_at,
                        )}</span></>
                        : "—"}
                    </span>
                  </td>
                  <td className="py-2.5 pr-4">
                    {r.status === "ACTIVE" ? (
                      <StatusTag tone="neutral">{resourceStatusLabel(r.status, r.mode)}</StatusTag>
                    ) : (
                      <a
                        href={`#health-${r.id}`}
                        className="inline-block"
                        title="查看健康详情"
                      >
                        <StatusTag
                          tone={ISOLATED.has(r.status) || r.status === "DEGRADED" ? "warning" : "neutral"}
                        >
                          {resourceStatusLabel(r.status, r.mode)}
                        </StatusTag>
                      </a>
                    )}
                  </td>
                  <td className="break-words py-2.5 pr-4 text-ql-fg-secondary">
                    {formatDateTimeFull(r.created_at)}
                  </td>
                  <td className="py-2.5 text-right">
                    <div className="flex flex-wrap justify-end gap-1">
                      <button data-write-action
                        className="rounded-md px-2 py-1 text-[12px] font-medium text-ql-action hover:bg-ql-action-soft"
                        onClick={() => {
                          setEditTarget(r);
                          editReset({
                            name: r.name,
                            concurrency_limit: r.concurrency_limit?.toString() ?? "",
                          });
                        }}
                        type="button"
                      >
                        编辑
                      </button>
                      <button data-write-action
                        className="rounded-md px-2 py-1 text-[12px] font-medium text-ql-action hover:bg-ql-action-soft"
                        onClick={() => {
                          setSyncTarget(r);
                        }}
                        type="button"
                      >同步模型</button>
                      {r.mode === "CODING_PLAN" ? <button data-write-action
                        className="rounded-md px-2 py-1 text-[12px] font-medium text-ql-action hover:bg-ql-action-soft"
                        onClick={async () => {
                          setOperatingTarget(r);
                          setOperatingDraft(operatingDraftFromResource(r));
                          setOperatingValidationError("");
                          const history = await get<{ snapshots: ProviderResourceOperatingSnapshot[] }>(
                            `/provider-resources/${r.id}/operating-snapshots`,
                          );
                          setOperatingHistory(history.snapshots);
                        }}
                        type="button"
                      >
                        更新额度配置
                      </button> : null}
                      {ISOLATED.has(r.status) ? (
                      <button data-write-action
                        className="rounded-md px-2 py-1 text-[12px] font-medium text-ql-warning hover:bg-ql-warning-soft focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ql-warning"
                        onClick={() => setRecoverTarget(r)}
                        type="button"
                      >
                        恢复
                      </button>
                      ) : null}
                      {r.archived_at ? (
                        <button data-write-action
                          className="rounded-md px-2 py-1 text-[12px] font-medium text-ql-action hover:bg-ql-action-soft"
                          disabled={unarchiveResourceMutation.isPending}
                          onClick={() => unarchiveResourceMutation.mutate(r.id)}
                          type="button"
                        >
                          {unarchiveResourceMutation.isPending ? "恢复中…" : "取消归档"}
                        </button>
                      ) : (
                        <>
                          <button data-write-action
                            className="rounded-md px-2 py-1 text-[12px] font-medium text-ql-fg-secondary hover:bg-ql-surface-subtle"
                            disabled={archiveResourceMutation.isPending}
                            onClick={() => archiveResourceMutation.mutate(r.id)}
                            type="button"
                          >
                            {archiveResourceMutation.isPending ? "归档中…" : "归档"}
                          </button>
                          <button data-write-action
                            className="rounded-md px-2 py-1 text-[12px] font-medium text-ql-danger hover:bg-ql-danger-soft"
                            onClick={() => setDeleteResourceTarget(r)}
                            type="button"
                          >
                            删除
                          </button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </QueryGate>
  </>;
}
