import { ScrollText } from "lucide-react";
import { useState } from "react";

import { useDeploymentLog, useDeploymentLogs, useOperationLogs } from "../api/hooks";
import type { DeploymentStatus } from "../api/types";
import { PageShell } from "../components/layout/PageShell";
import { StatusTag } from "../components/dashboard/StatusTag";
import { QueryGate } from "../components/states/QueryGate";
import { useRedirectOnUnauthorized } from "../components/useRedirectOnUnauthorized";
import { formatDateTimeFull } from "../lib/format";

export function SettingsPage() {
  const [tab, setTab] = useState<"operations" | "deployments">("operations");
  const [status, setStatus] = useState<DeploymentStatus | "">("");
  const [version, setVersion] = useState("");
  const [poolRef, setPoolRef] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const operationQuery = useOperationLogs(100);
  const deploymentQuery = useDeploymentLogs({
    status: status || undefined,
    version: version.trim() || undefined,
    poolRef: poolRef.trim() || undefined,
  });
  const detailQuery = useDeploymentLog(selectedId);
  useRedirectOnUnauthorized(operationQuery.error ?? deploymentQuery.error ?? detailQuery.error);

  return (
    <PageShell description="管理动作与生产版本升级的独立审计时间线" title="系统日志">
      <div className="mb-4 flex gap-2 border-b border-ql-border">
        <Tab active={tab === "operations"} onClick={() => setTab("operations")}>操作日志</Tab>
        <Tab active={tab === "deployments"} onClick={() => setTab("deployments")}>升级日志</Tab>
      </div>
      {tab === "operations" ? (
        <OperationLogs query={operationQuery} />
      ) : (
        <div className="space-y-4">
          <div className="grid gap-3 rounded-lg border border-ql-border p-3 md:grid-cols-3">
            <select aria-label="升级状态" className="ql-input" value={status} onChange={(event) =>
              setStatus(event.target.value as DeploymentStatus | "")}
            >
              <option value="">全部状态</option>
              <option value="IN_PROGRESS">进行中</option>
              <option value="SUCCEEDED">成功</option>
              <option value="FAILED">失败</option>
              <option value="ROLLED_BACK">已回滚</option>
            </select>
            <input aria-label="版本或 Commit" className="ql-input" onChange={(event) =>
              setVersion(event.target.value)} placeholder="版本或 Commit" value={version} />
            <input aria-label="问题编号" className="ql-input" onChange={(event) =>
              setPoolRef(event.target.value)} placeholder="POOL-026" value={poolRef} />
          </div>
          <DeploymentLogs query={deploymentQuery} onSelect={setSelectedId} />
          {selectedId ? <DeploymentDetail query={detailQuery} /> : null}
        </div>
      )}
    </PageShell>
  );
}

function Tab(props: { active: boolean; onClick: () => void; children: string }) {
  return <button className={`border-b-2 px-4 py-2 text-[13px] ${props.active
    ? "border-ql-brand text-ql-brand" : "border-transparent text-ql-fg-secondary"}`}
    onClick={props.onClick} type="button">{props.children}</button>;
}

function OperationLogs({ query }: { query: ReturnType<typeof useOperationLogs> }) {
  const logs = query.data?.logs ?? [];
  return <QueryGate emptyDescription="登记资源、创建主体、停用等动作会在此留痕。"
    emptyIcon={ScrollText} emptyTitle="暂无操作日志" error={query.error}
    isEmpty={logs.length === 0} isLoading={query.isLoading} loadingRows={6}
    onRetry={() => void query.refetch()}>
    <Table headers={["时间", "动作", "对象类型", "对象", "结果", "变更摘要"]}>
      {logs.map((log) => <tr className="border-b border-ql-border-zone" key={log.id}>
        <Cell>{formatDateTimeFull(log.created_at)}</Cell><Cell>{log.action}</Cell>
        <Cell>{log.target_type}</Cell><Cell>{log.target_id ?? "—"}</Cell>
        <Cell><StatusTag tone={log.result === "SUCCESS" ? "neutral" : "danger"}>{log.result === "SUCCESS" ? "成功" : "失败"}</StatusTag></Cell>
        <Cell>{log.change_summary ? JSON.stringify(log.change_summary) : "—"}</Cell>
      </tr>)}
    </Table>
  </QueryGate>;
}

function DeploymentLogs({ query, onSelect }: {
  query: ReturnType<typeof useDeploymentLogs>;
  onSelect: (id: string) => void;
}) {
  const items = query.data?.items ?? [];
  return <QueryGate emptyDescription="发布流程导入 Manifest 后会自动形成升级记录。"
    emptyIcon={ScrollText} emptyTitle="暂无升级日志" error={query.error}
    isEmpty={items.length === 0} isLoading={query.isLoading} loadingRows={6}
    onRetry={() => void query.refetch()}>
    <Table headers={["开始时间", "版本", "迁移", "关联问题", "状态", "操作人", "摘要"]}>
      {items.map((item) => <tr className="border-b border-ql-border-zone" key={item.id}>
        <Cell>{formatDateTimeFull(item.started_at)}</Cell>
        <Cell><button className="text-left text-ql-brand" onClick={() => onSelect(item.id)} type="button">
          {item.from_version ?? "—"} → {item.to_version ?? "—"}
        </button>{item.git_commit ? <small className="block font-mono">{item.git_commit.slice(0, 12)}</small> : null}</Cell>
        <Cell>{item.migration_from ?? "—"} → {item.migration_to ?? "—"}</Cell>
        <Cell>{item.pool_refs.join("、") || "—"}</Cell>
        <Cell><DeploymentStatusTag status={item.status} /></Cell>
        <Cell>{item.actor}</Cell><Cell>{item.summary}</Cell>
      </tr>)}
    </Table>
  </QueryGate>;
}

function DeploymentDetail({ query }: { query: ReturnType<typeof useDeploymentLog> }) {
  if (!query.data) return null;
  const { deployment, events } = query.data;
  return <section className="rounded-lg border border-ql-border p-4 text-[13px]">
    <h2 className="font-semibold">升级详情 · {deployment.deployment_id}</h2>
    <div className="mt-3 grid gap-2 md:grid-cols-2">
      <Detail label="候选包 SHA-256" value={deployment.artifact_sha256 ?? "—"} />
      <Detail label="Release" value={deployment.release_id ?? "—"} />
      <Detail label="备份引用" value={deployment.backup_ref ?? "—"} />
      <Detail label="回滚目标" value={deployment.rollback_target ?? "—"} />
      <Detail label="健康检查" value={deployment.health_summary ? JSON.stringify(deployment.health_summary) : "—"} />
      <Detail label="生产冒烟" value={deployment.smoke_summary ? JSON.stringify(deployment.smoke_summary) : "—"} />
      <Detail label="Evidence" value={deployment.evidence_refs.join("、") || "—"} />
      <Detail label="失败分类" value={deployment.failure_classification ?? "—"} />
    </div>
    <h3 className="mt-4 font-semibold">时间线</h3>
    <ol className="mt-2 space-y-1">{events.map((event) => <li key={event.id}>
      {formatDateTimeFull(event.occurred_at)} · {event.event_type} · {event.note ?? "—"}
    </li>)}</ol>
  </section>;
}

function DeploymentStatusTag({ status }: { status: DeploymentStatus }) {
  const label = { IN_PROGRESS: "进行中", SUCCEEDED: "成功", FAILED: "失败", ROLLED_BACK: "已回滚" }[status];
  return <StatusTag tone={status === "SUCCEEDED" ? "neutral" : status === "IN_PROGRESS" ? "warning" : "danger"}>{label}</StatusTag>;
}

function Table({ headers, children }: { headers: string[]; children: React.ReactNode }) {
  return <div className="overflow-x-auto"><table className="w-full border-collapse text-left">
    <thead><tr className="border-b border-ql-border text-[12px] text-ql-fg-tertiary">
      {headers.map((header) => <th className="py-2 pr-4 font-medium" key={header}>{header}</th>)}
    </tr></thead><tbody>{children}</tbody></table></div>;
}

function Cell({ children }: { children: React.ReactNode }) {
  return <td className="max-w-[16rem] py-2.5 pr-4 text-[12px] text-ql-fg-secondary">{children}</td>;
}

function Detail({ label, value }: { label: string; value: string }) {
  return <div><span className="text-ql-fg-tertiary">{label}：</span><span className="break-all font-mono">{value}</span></div>;
}
