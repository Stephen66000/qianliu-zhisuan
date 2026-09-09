/**
 * POOL-032：厂商额度窗口面板。
 *
 * 展示厂商 Coding Plan 返回的实时窗口额度（5 小时/周），与仟流本地累计（账本 token）、
 * 供给预测口径严格区分。硬约束：缺失字段一律显示「厂商未提供」，绝不显示 0；
 * 同步失败保留最后一次成功快照（保鲜），不影响资源健康状态。
 *
 * 与后端对齐：GET /provider-resources/:id/quota-windows（快照） +
 * POST /provider-resources/:id/quota-sync（手动触发，失败保鲜由后端处理）。
 */
import type { Provider, ProviderResourceItem, ProviderQuotaWindow } from "../../api/types";
import { useQuotaWindows, useSyncQuotaWindow } from "../../api/hooks";
import { formatDateTimeFull, formatDecimal } from "../../lib/format";

/** 厂商同步错误码 → 可读原因（与 provider-adapters CodingPlanQuotaError.code 对齐）。 */
const SYNC_ERROR_LABEL: Record<string, string> = {
  RATE_LIMITED: "厂商返回 429（限流）",
  UNAUTHORIZED: "厂商返回 401（凭证可能失效）",
  INVALID_RESPONSE: "厂商返回了无法解析的响应",
  UPSTREAM_UNAVAILABLE: "厂商服务暂时不可用",
};

const WINDOW_TITLE: Record<ProviderQuotaWindow["window_type"], string> = {
  WEEKLY: "周额度",
  FIVE_HOUR: "滚动 5 小时额度",
};

interface QuotaWindowPanelProps {
  resources: ProviderResourceItem[];
  providers: Provider[];
}

export function QuotaWindowPanel({ resources, providers }: QuotaWindowPanelProps) {
  if (resources.length === 0) return null;
  return (
    <section className="mt-5 rounded-xl border border-ql-border bg-ql-surface p-4">
      <h2 className="text-[14px] font-semibold text-ql-fg">厂商额度窗口</h2>

      <div className="mt-3 space-y-3">
        {resources.map((resource) => (
          <QuotaWindowResourceCard
            key={resource.id}
            providerName={providers.find((p) => p.id === resource.provider_id)?.name ?? "—"}
            resource={resource}
          />
        ))}
      </div>

      <div className="mt-4 flex flex-wrap gap-x-4 gap-y-1 border-t border-ql-border-zone pt-3 text-[11px] text-ql-fg-tertiary">
        <span className="font-medium text-ql-fg-secondary">口径说明</span>
        <span>● 厂商事实（本区，百分比/额度点）</span>
        <span>○ 本地累计（账本 token）</span>
        <span>○ 供给预测（算法估算）</span>
        <span>
          数据来源：<strong className="font-medium text-ql-fg-secondary">PROVIDER_SYNC</strong>（厂商接口自动同步）
        </span>
      </div>
    </section>
  );
}

function QuotaWindowResourceCard({
  resource,
  providerName,
}: {
  resource: ProviderResourceItem;
  providerName: string;
}) {
  const windowsQuery = useQuotaWindows(resource.id);
  const sync = useSyncQuotaWindow(resource.id);

  // 非 Coding Plan 套餐资源（如 DeepSeek 按量 API）不适用。
  if (resource.mode !== "CODING_PLAN") {
    return (
      <article className="rounded-lg border border-ql-border-zone bg-ql-surface-subtle p-3.5">
        <div className="flex items-start justify-between gap-2">
          <div>
            <p className="text-[13px] font-semibold text-ql-fg">{resource.name}</p>
            <p className="mt-0.5 text-[11px] text-ql-fg-tertiary">
              {providerName} · API · 按 token 计费
            </p>
          </div>
          <span className="rounded-md bg-ql-surface-muted px-2 py-0.5 text-[11px] font-medium text-ql-fg-secondary">
            API 计费
          </span>
        </div>
        <p className="mt-3 text-[12px] text-ql-fg-tertiary">
          不适用 — 非 Coding Plan 套餐资源，无厂商窗口额度。
        </p>
      </article>
    );
  }

  const windows = windowsQuery.data?.windows ?? [];

  return (
    <article className="rounded-lg border border-ql-border-zone bg-ql-surface-subtle p-3.5">
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-[13px] font-semibold text-ql-fg">{resource.name}</p>
          <p className="mt-0.5 text-[11px] text-ql-fg-tertiary">
            {providerName} · CODING_PLAN · 资源 ID {resource.id.slice(0, 8)}…
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="rounded-md bg-ql-surface-brand-soft px-2 py-0.5 text-[11px] font-medium text-ql-action">
            Coding Plan
          </span>
          <button data-write-action
            className="h-8 rounded-lg border border-ql-action px-3 text-[12px] font-medium text-ql-action hover:bg-ql-action-soft disabled:opacity-50"
            disabled={sync.isPending}
            onClick={() => sync.mutate()}
            type="button"
          >
            {sync.isPending ? "同步中…" : "立即同步"}
          </button>
        </div>
      </div>

      {/* 同步中的瞬时提示（后端仍在调用厂商） */}
      {sync.isPending ? (
        <p className="mt-3 rounded-md bg-ql-warning-soft px-2.5 py-1.5 text-[11px] text-ql-warning">
          同步中… 正在调用厂商额度接口（超时 10s，最多重试 2 次）。
        </p>
      ) : null}

      {windows.length === 0 ? (
        // 从未同步：无任何窗口快照。
        <p className="mt-3 text-[12px] text-ql-fg-tertiary">
          未同步 — 点击右上「立即同步」首次拉取厂商额度。
        </p>
      ) : (
        <div className="mt-3 grid grid-cols-1 gap-3.5 sm:grid-cols-2">
          {windows.map((window) => (
            <QuotaWindowCard key={`${window.window_type}-${window.id}`} window={window} />
          ))}
        </div>
      )}

      <FreshnessRow windows={windows} />

      {sync.isError ? (
        <p className="mt-2 rounded-md bg-ql-danger-soft px-2.5 py-1.5 text-[11px] text-ql-danger" role="alert">
          {sync.error.message}
        </p>
      ) : null}
    </article>
  );
}

function QuotaWindowCard({ window }: { window: ProviderQuotaWindow }) {
  const hasValue = window.used_value !== null && window.used_value !== undefined;
  // UNSUPPORTED：厂商未提供该窗口，不伪造数值。
  if (window.sync_status === "UNSUPPORTED" || !hasValue) {
    return (
      <div className="rounded-lg bg-ql-surface p-3">
        <p className="text-[12px] font-semibold text-ql-fg-secondary">{WINDOW_TITLE[window.window_type]}</p>
        <p className="mt-2 text-[12px] text-ql-fg-tertiary">
          厂商未提供实时查询
          <br />
          <span className="text-ql-fg-tertiary">厂商公开接口未解析该窗口已用/剩余，不显示估算值</span>
        </p>
      </div>
    );
  }

  const ratio = window.ratio !== null ? Number(window.ratio) : null;
  const ratioPct = ratio !== null && Number.isFinite(ratio)
    ? Math.min(Math.max(ratio * 100, 0), 100)
    : null;
  // 高占用（≥70%）用警告色，正常用 action/accent。数值本身绝不重算。
  const barTone =
    ratioPct !== null && ratioPct >= 70
      ? "bg-ql-warning"
      : window.window_type === "WEEKLY"
        ? "bg-ql-action"
        : "bg-ql-accent-text";
  const valTone = ratioPct !== null && ratioPct >= 70 ? "text-ql-warning" : "text-ql-action";
  const unitLabel = window.unit === "PERCENT" ? "%" : window.unit === "POINT" ? "额度点" : "";

  return (
    <div className="rounded-lg bg-ql-surface p-3">
      <div className="flex items-center justify-between">
        <p className="text-[12px] font-semibold text-ql-fg-secondary">
          {WINDOW_TITLE[window.window_type]}
        </p>
        {window.reset_at ? (
          <span className="text-[11px] text-ql-fg-tertiary">重置 {formatDateTimeFull(window.reset_at)}</span>
        ) : null}
      </div>
      <div className="mt-2 flex items-baseline gap-1">
        <span className={`font-mono text-[20px] font-bold ${valTone}`}>{formatDecimal(window.used_value!)}</span>
        {window.limit_value !== null ? (
          <span className="text-[13px] text-ql-fg-tertiary">/ {formatDecimal(window.limit_value)}</span>
        ) : null}
        {unitLabel ? <span className="text-[11px] text-ql-fg-tertiary">{unitLabel}</span> : null}
      </div>
      {ratioPct !== null ? (
        <div className="mt-2 h-2 overflow-hidden rounded bg-ql-surface-muted">
          <div className={`h-full rounded ${barTone}`} style={{ width: `${ratioPct}%` }} />
        </div>
      ) : null}
      <p className="mt-1.5 text-[11px] text-ql-fg-tertiary">
        已用 {formatDecimal(window.used_value!)}
        {window.remaining_value !== null ? ` · 剩余 ${formatDecimal(window.remaining_value)}` : ""}
        {window.reset_at ? ` · 重置 ${formatDateTimeFull(window.reset_at)}` : ""}
      </p>
    </div>
  );
}

/** 整张资源卡的同步新鲜度提示 + 失败保鲜说明。 */
function FreshnessRow({ windows }: { windows: ProviderQuotaWindow[] }) {
  if (windows.length === 0) {
    return <p className="mt-2.5 text-[11px] text-ql-fg-tertiary">○ 从未成功同步</p>;
  }
  // 取代表窗口（优先 SUCCESS，其次 STALE，最后 FAILED）判定整卡新鲜度。
  const ranked = [...windows].sort(byFreshnessRank);
  const head = ranked[0]!;
  const reason = head.sync_error_code ? SYNC_ERROR_LABEL[head.sync_error_code] ?? head.sync_error_code : null;

  if (head.sync_status === "STALE") {
    return (
      <div className="mt-2.5">
        <p className="text-[11px] text-ql-warning">
          ⚠ 数据已过期 · 最后成功 {head.last_success_at ? formatDateTimeFull(head.last_success_at) : "无"}
        </p>
        <p className="mt-2 rounded-md bg-ql-danger-soft px-2.5 py-1.5 text-[11px] text-ql-danger">
          {reason
            ? `同步失败 · ${reason}，已保留上次成功快照，不影响 Gateway 正常请求与资源健康状态。重试将在下个周期自动进行。`
            : "同步失败，已保留上次成功快照。重试将在下个周期自动进行。"}
        </p>
      </div>
    );
  }
  if (head.sync_status === "FAILED") {
    return (
      <p className="mt-2.5 text-[11px] text-ql-fg-tertiary">
        ○ 从未成功同步{reason ? `（${reason}）` : ""}
      </p>
    );
  }
  // SUCCESS / UNSUPPORTED：显示最近一次数据时间。
  const dataAt = head.provider_data_at ?? head.collected_at;
  return (
    <p className="mt-2.5 text-[11px] text-ql-success">
      ✓ 同步成功 · 数据截至 {formatDateTimeFull(dataAt)} · 来源 {head.adapter_version}
    </p>
  );
}

/** 排序：SUCCESS 优先，UNSUPPORTED 次之，STALE 再次，FAILED 最后。 */
function byFreshnessRank(a: ProviderQuotaWindow, b: ProviderQuotaWindow): number {
  const rank: Record<ProviderQuotaWindow["sync_status"], number> = {
    SUCCESS: 0,
    UNSUPPORTED: 1,
    STALE: 2,
    FAILED: 3,
  };
  return rank[a.sync_status] - rank[b.sync_status];
}
