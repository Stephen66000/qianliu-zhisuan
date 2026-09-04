/**
 * POOL-031：资源健康与异常面板。
 *
 * 在供给预测下方按资源展示健康详情：当前状态、可用性、稳定原因码、调度影响、
 * 失败证据（首次/最近/连续次数/最近成功）、恢复说明与处置入口。
 * 数据由服务端聚合（GET /provider-resources/:id/health），前端不解析日志。
 * 经营数据缺失、预测不可计算与本模块严格分栏，不混为健康降级原因。
 */
import type { Provider, ProviderResourceItem } from "../../api/types";
import { useResourceHealth } from "../../api/hooks";
import { formatDateTimeFull } from "../../lib/format";
import { resourceStatusLabel } from "../../lib/resource-status";

interface ResourceHealthPanelProps {
  resources: ProviderResourceItem[];
  providers: Provider[];
}

export function ResourceHealthPanel({ resources, providers }: ResourceHealthPanelProps) {
  if (resources.length === 0) return null;
  return (
    <section className="mt-5 rounded-xl border border-ql-border bg-ql-surface p-4">
      <h2 className="text-[14px] font-semibold text-ql-fg">资源健康与异常</h2>
      <p className="mt-1 text-[12px] text-ql-fg-tertiary">
        按资源展示运行状态、原因、调度影响和恢复说明。与经营数据缺口、预测不可计算分栏呈现。
      </p>
      <div className="mt-3 space-y-3">
        {resources.map((resource) => (
          <HealthResourceCard
            key={resource.id}
            providerName={providers.find((p) => p.id === resource.provider_id)?.name ?? "—"}
            resource={resource}
          />
        ))}
      </div>
    </section>
  );
}

function HealthResourceCard({
  providerName,
  resource,
}: {
  providerName: string;
  resource: ProviderResourceItem;
}) {
  const healthQuery = useResourceHealth(resource.id);

  return (
    <div id={`health-${resource.id}`} className="rounded-lg border border-ql-border-zone bg-ql-surface-subtle p-3 scroll-mt-4">
      <div className="flex items-center justify-between gap-2">
        <div>
          <p className="text-[13px] font-medium text-ql-fg">
            {providerName} · {resource.name}
          </p>
          <p className="text-[11px] text-ql-fg-tertiary">{resource.mode === "CODING_PLAN" ? "套餐" : "API"}</p>
        </div>
        <StatusBadge label={healthQuery.data?.status_label} mode={resource.mode} status={resource.status} />
      </div>

      {healthQuery.isLoading ? (
        <p className="mt-2 text-[12px] text-ql-fg-tertiary">加载健康详情…</p>
      ) : healthQuery.isError ? (
        <p className="mt-2 text-[12px] text-ql-danger">健康详情获取失败</p>
      ) : healthQuery.data ? (
        <HealthDetail resource={resource} />
      ) : null}
    </div>
  );
}

function HealthDetail({ resource }: { resource: ProviderResourceItem }) {
  // useResourceHealth 在父组件已调用，这里用同一 hook 取缓存数据。
  const { data: health } = useResourceHealth(resource.id);
  if (!health) return null;

  return (
    <div className="mt-2 space-y-2">
      {/* 调度影响 + 恢复说明 */}
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-[12px]">
        <span className="text-ql-fg-secondary">
          调度影响：<span className="text-ql-fg">{health.dispatch_impact}</span>
        </span>
        <span className="text-ql-fg-secondary">
          可用性：<span className={health.available ? "text-ql-success" : "text-ql-danger"}>
            {health.available ? "允许请求" : "禁止准入"}
          </span>
          {health.probe ? "（半开探测）" : ""}
        </span>
      </div>

      {/* 原因码 */}
      {health.reason_label ? (
        <p className="text-[12px] text-ql-fg-secondary">
          状态原因：<span className="text-ql-fg">{health.reason_label}</span>
          {health.error_classification ? (
            <span className="ml-1 text-ql-fg-tertiary">（{health.error_classification}）</span>
          ) : null}
        </p>
      ) : null}

      {/* 失败证据 */}
      {resource.status !== "ACTIVE" ? (
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-ql-fg-tertiary">
          <span>连续失败 {resource.consecutive_failures} 次</span>
          {health.first_occurred_at ? <span>首次：{formatDateTimeFull(health.first_occurred_at)}</span> : null}
          {health.last_occurred_at ? <span>最近：{formatDateTimeFull(health.last_occurred_at)}</span> : null}
          {health.last_success_at ? <span>最近成功：{formatDateTimeFull(health.last_success_at)}</span> : null}
          {health.last_quota_sync_at ? <span>额度同步：{formatDateTimeFull(health.last_quota_sync_at)}</span> : null}
          {health.cooldown_until ? <span>冷却至：{formatDateTimeFull(health.cooldown_until)}</span> : null}
          {health.credential_refresh_status && health.credential_refresh_status !== "OK" ? (
            <span className="text-ql-warning">凭证刷新：{health.credential_refresh_status}</span>
          ) : null}
          {health.refresh_error_classification ? (
            <span className="text-ql-warning">{health.refresh_error_classification}</span>
          ) : null}
        </div>
      ) : null}
      {health.status_event_time_reliable === false ? (
        <p className="text-[11px] text-ql-warning">历史状态事件的时间被旧迁移冻结，首次/最近时间不展示；最近成功取真实请求账本。</p>
      ) : null}

      {/* 恢复说明 */}
      <p className="text-[12px] text-ql-fg-secondary">
        <span className="text-ql-fg-tertiary">恢复：</span>{health.recovery_guide}
      </p>
    </div>
  );
}

/** 状态色标（POOL-031：DEGRADED 显示「降级（仍可使用）」）。 */
function StatusBadge({ status, mode, label: providedLabel }: {
  status: string; mode: ProviderResourceItem["mode"]; label?: string;
}) {
  const tone =
    status === "ACTIVE" ? "neutral"
    : status === "DEGRADED" ? "warning"
    : "danger";
  const label = providedLabel ?? resourceStatusLabel(status, mode);

  const colorClass =
    tone === "neutral" ? "bg-ql-surface-brand-soft text-ql-action"
    : tone === "warning" ? "bg-ql-surface-warning-soft text-ql-warning"
    : "bg-ql-surface-danger-soft text-ql-danger";

  return (
    <span className={`rounded px-2 py-0.5 text-[11px] font-medium ${colorClass}`}>
      {label}
    </span>
  );
}
