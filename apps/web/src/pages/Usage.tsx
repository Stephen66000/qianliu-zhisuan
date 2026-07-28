/**
 * W18 用量账本 —— GET /usage 分页表格（PRD §10.3 请求级列表）。
 *
 * W18 范围：列表 + 分页；路由过程下钻在 W20（/gateway-requests/{id} 子路由）。
 * 数字右对齐 tabular-nums；totalApiCost "0" = 套餐内（TRD §10.2：不写 ¥0）。
 * 状态颜色纪律：SUCCEEDED/IN_PROGRESS 中性灰，FAILED 才 danger 红。
 */
import { useState } from "react";
import { ChevronDown, ChevronRight, Inbox } from "lucide-react";

import { useUsage } from "../api/hooks";
import type { UsageRecord } from "../api/types";
import { PageShell } from "../components/layout/PageShell";
import { StatusTag } from "../components/dashboard/StatusTag";
import { EmptyState } from "../components/states/EmptyState";
import { ErrorState } from "../components/states/ErrorState";
import { LoadingState } from "../components/states/LoadingState";
import { useRedirectOnUnauthorized } from "../components/useRedirectOnUnauthorized";
import { formatCount, formatDateTimeFull, formatDuration, formatMoney } from "../lib/format";
import { RequestDrilldown } from "./RequestDrilldown";

const PAGE_SIZE = 20;

const STATUS_LABEL: Record<string, string> = {
  SUCCEEDED: "成功",
  FAILED: "失败",
  IN_PROGRESS: "进行中",
};

function StatusCell({ status }: { status: string }) {
  if (status === "FAILED") {
    return <StatusTag tone="danger">{STATUS_LABEL[status] ?? status}</StatusTag>;
  }
  return <StatusTag tone="neutral">{STATUS_LABEL[status] ?? status}</StatusTag>;
}

/** API 实际费用："0" = 套餐内（TRD §10.2 PACKAGE_INCLUDED，不写数值 0）。 */
function ApiCostCell({ record }: { record: UsageRecord }) {
  if (record.totalApiCost === "0" || record.totalApiCost === "0.00000000") {
    return <span className="text-ql-fg-secondary">套餐内</span>;
  }
  return <span>{formatMoney(record.totalApiCost)}</span>;
}

/** 单行 + 可展开路由过程下钻（W20）。 */
function UsageRow({
  record,
  expanded,
  onToggle,
}: {
  record: UsageRecord;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <>
      <tr
        className="border-b border-ql-border-zone text-[13px] leading-5 text-ql-fg hover:bg-ql-surface-subtle"
        key={record.requestId}
      >
        <td className="py-2.5 pr-2">
          <button
            aria-expanded={expanded}
            aria-label={expanded ? "收起路由过程" : "展开路由过程"}
            className="flex h-6 w-6 items-center justify-center rounded-md text-ql-fg-tertiary hover:bg-ql-surface-muted hover:text-ql-fg focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ql-action"
            onClick={onToggle}
            type="button"
          >
            {expanded ? (
              <ChevronDown aria-hidden className="h-4 w-4" />
            ) : (
              <ChevronRight aria-hidden className="h-4 w-4" />
            )}
          </button>
        </td>
        <td className="max-w-[10rem] truncate py-2.5 pr-4 font-mono text-[12px] text-ql-fg-secondary">
          {record.requestId}
        </td>
        <td className="py-2.5 pr-4 font-medium">{record.principalName}</td>
        <td className="py-2.5 pr-4 text-ql-fg-secondary">{record.unifiedModel}</td>
        <td className="py-2.5 pr-4 text-right [font-variant-numeric:tabular-nums]">
          {formatCount(record.totalInputTokens)}
        </td>
        <td className="py-2.5 pr-4 text-right [font-variant-numeric:tabular-nums]">
          {formatCount(record.totalOutputTokens)}
        </td>
        <td className="py-2.5 pr-4 text-right [font-variant-numeric:tabular-nums]">
          {formatCount(record.totalCacheTokens)}
        </td>
        <td className="py-2.5 pr-4 text-right [font-variant-numeric:tabular-nums]">
          {formatCount(record.totalDeductedQuota)}
        </td>
        <td className="py-2.5 pr-4 text-right [font-variant-numeric:tabular-nums]">
          <ApiCostCell record={record} />
        </td>
        <td className="py-2.5 pr-4">
          <StatusCell status={record.status} />
        </td>
        <td className="whitespace-nowrap py-2.5 pr-4 text-ql-fg-secondary">
          {formatDateTimeFull(record.startedAt)}
        </td>
        <td className="py-2.5 text-right [font-variant-numeric:tabular-nums]">
          {record.durationMs === null ? "—" : formatDuration(record.durationMs)}
        </td>
      </tr>
      {expanded ? (
        <tr className="border-b border-ql-border-zone">
          <td className="bg-ql-surface-subtle p-3" colSpan={13}>
            <RequestDrilldown requestId={record.requestId} />
          </td>
        </tr>
      ) : null}
    </>
  );
}

export function UsagePage() {
  const [page, setPage] = useState(0);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const query = useUsage({ limit: PAGE_SIZE, offset: page * PAGE_SIZE });
  useRedirectOnUnauthorized(query.error);

  const total = query.data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <PageShell description="每条记录对应一次业务请求；路由过程下钻将在后续版本提供" title="用量账本">
      {query.isLoading ? (
        <LoadingState label="正在加载账本记录…" rows={6} />
      ) : query.error || !query.data ? (
        <ErrorState
          message={query.error?.message ?? "账本记录加载失败"}
          onRetry={() => void query.refetch()}
        />
      ) : query.data.records.length === 0 ? (
        /* PRD §10.4：用量账本为空 → 说明为什么为空 + 下一步，不得混入测试数据 */
        <EmptyState
          description="当前筛选条件没有账本记录。可清除筛选或发起真实调用；本页不展示模拟数据。"
          icon={Inbox}
          title="没有账本记录"
        />
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left">
              <thead>
                <tr className="border-b border-ql-border text-[12px] leading-[18px] text-ql-fg-tertiary">
                  <th aria-label="展开" className="py-2 pr-2 font-medium" />
                  <th className="py-2 pr-4 font-medium">请求 ID</th>
                  <th className="py-2 pr-4 font-medium">发起主体</th>
                  <th className="py-2 pr-4 font-medium">模型</th>
                  <th className="py-2 pr-4 text-right font-medium">输入 Token</th>
                  <th className="py-2 pr-4 text-right font-medium">输出 Token</th>
                  <th className="py-2 pr-4 text-right font-medium">缓存 Token</th>
                  <th className="py-2 pr-4 text-right font-medium">扣减额度</th>
                  <th className="py-2 pr-4 text-right font-medium">API 费用（元）</th>
                  <th className="py-2 pr-4 font-medium">状态</th>
                  <th className="py-2 pr-4 font-medium">开始时间</th>
                  <th className="py-2 text-right font-medium">耗时</th>
                </tr>
              </thead>
              <tbody>
                {query.data.records.map((record) => {
                  const expanded = expandedId === record.requestId;
                  return (
                    <UsageRow
                      expanded={expanded}
                      key={record.requestId}
                      onToggle={() => setExpandedId(expanded ? null : record.requestId)}
                      record={record}
                    />
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="mt-4 flex items-center justify-between">
            <p className="text-[12px] leading-[18px] text-ql-fg-tertiary">
              共 {formatCount(String(total))} 条 · 第 {page + 1} / {totalPages} 页
            </p>
            <div className="flex items-center gap-2">
              <button
                className="h-8 rounded-lg border border-ql-border bg-ql-surface px-3 text-[13px] text-ql-fg hover:border-ql-border-strong disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ql-action"
                disabled={page === 0}
                onClick={() => setPage((p) => Math.max(0, p - 1))}
                type="button"
              >
                上一页
              </button>
              <button
                className="h-8 rounded-lg border border-ql-border bg-ql-surface px-3 text-[13px] text-ql-fg hover:border-ql-border-strong disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ql-action"
                disabled={page + 1 >= totalPages}
                onClick={() => setPage((p) => p + 1)}
                type="button"
              >
                下一页
              </button>
            </div>
          </div>
        </>
      )}
    </PageShell>
  );
}
