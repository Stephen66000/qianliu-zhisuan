/**
 * W20 系统设置 —— 操作日志（审计追踪）。
 *
 * 操作日志：GET /operation-logs（管理动作审计，W20 收口七入口）。
 * 主题偏好在顶栏；一期无其他可配置项。
 */
import { ScrollText } from "lucide-react";

import { useOperationLogs } from "../api/hooks";
import { PageShell } from "../components/layout/PageShell";
import { StatusTag } from "../components/dashboard/StatusTag";
import { QueryGate } from "../components/states/QueryGate";
import { useRedirectOnUnauthorized } from "../components/useRedirectOnUnauthorized";
import { formatDateTimeFull } from "../lib/format";

export function SettingsPage() {
  const query = useOperationLogs(100);
  useRedirectOnUnauthorized(query.error);

  const logs = query.data?.logs ?? [];

  return (
    <PageShell
      description="管理动作审计追踪（主题偏好在页面顶栏切换）"
      title="系统设置 · 操作日志"
    >
      <QueryGate
        emptyDescription="暂无管理操作记录。登记资源、创建主体、停用、凭证恢复等动作会在此留痕。"
        emptyIcon={ScrollText}
        emptyTitle="暂无操作日志"
        error={query.error}
        isEmpty={logs.length === 0}
        isLoading={query.isLoading}
        loadingRows={6}
        onRetry={() => void query.refetch()}
      >
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left">
            <thead>
              <tr className="border-b border-ql-border text-[12px] leading-[18px] text-ql-fg-tertiary">
                <th className="py-2 pr-4 font-medium">时间</th>
                <th className="py-2 pr-4 font-medium">动作</th>
                <th className="py-2 pr-4 font-medium">对象类型</th>
                <th className="py-2 pr-4 font-medium">对象</th>
                <th className="py-2 pr-4 font-medium">结果</th>
                <th className="py-2 font-medium">变更摘要</th>
              </tr>
            </thead>
            <tbody>
              {logs.map((log) => (
                <tr
                  className="border-b border-ql-border-zone text-[13px] leading-5 text-ql-fg last:border-b-0 hover:bg-ql-surface-subtle"
                  key={log.id}
                >
                  <td className="whitespace-nowrap py-2.5 pr-4 text-ql-fg-secondary">
                    {formatDateTimeFull(log.created_at)}
                  </td>
                  <td className="py-2.5 pr-4 font-medium">{log.action}</td>
                  <td className="py-2.5 pr-4 text-ql-fg-secondary">{log.target_type}</td>
                  <td className="max-w-[8rem] truncate py-2.5 pr-4 font-mono text-[12px] text-ql-fg-tertiary">
                    {log.target_id ?? "—"}
                  </td>
                  <td className="py-2.5 pr-4">
                    <StatusTag tone={log.result === "SUCCESS" ? "neutral" : "danger"}>
                      {log.result === "SUCCESS" ? "成功" : "失败"}
                    </StatusTag>
                  </td>
                  <td className="max-w-[16rem] truncate py-2.5 font-mono text-[12px] text-ql-fg-tertiary">
                    {log.change_summary ? JSON.stringify(log.change_summary) : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </QueryGate>
    </PageShell>
  );
}
