import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { get, post } from "../../api/client";
import { useAccess } from "../../permissions";
import { formatDateTimeFull } from "../../lib/format";

interface Probe {
  id: string; status: string; upstreamModel: string; credentialVersion: number | null;
  httpStatus: number | null; errorCode: string | null; startedAt: string; finishedAt: string | null; retryAt: string;
}
const labels: Record<string, string> = {
  RUNNING: "验证中", RECOVERED: "验证通过，已解除隔离", FAILED: "验证失败，保持隔离",
  STALE: "凭证或故障已变化，本次结果未用于恢复", CANCELLED: "验证已取消", EXPIRED: "验证超时，未恢复",
};

export function CredentialProbeAction({ resourceId, isolated }: { resourceId: string; isolated: boolean }) {
  const access = useAccess();
  const client = useQueryClient();
  const [confirmed, setConfirmed] = useState(false);
  const key = useRef<string | null>(null);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  const path = `/provider-resources/${resourceId}/credential-probes`;
  const query = useQuery({ queryKey: ["credential-probes", resourceId],
    queryFn: ({ signal }) => get<{ probes: Probe[] }>(path, signal), retry: false,
    refetchInterval: (query) => query.state.data?.probes[0]?.status === "RUNNING" ? 5000 : false });
  const mutation = useMutation({ retry: false, mutationFn: () => {
    key.current ??= crypto.randomUUID();
    controller.current = new AbortController();
    return post<{ probe: Probe }>(path, { idempotency_key: key.current,
      confirm_quota_consumption: true }, controller.current.signal);
  }, onSuccess: () => { key.current = null; setConfirmed(false); }, onSettled: async () => {
    await Promise.all([
      client.invalidateQueries({ queryKey: ["credential-probes", resourceId] }),
      client.invalidateQueries({ queryKey: ["resource-health", resourceId] }),
      client.invalidateQueries({ queryKey: ["provider-resources"] }),
      client.invalidateQueries({ queryKey: ["principals"] }),
    ]);
  } });
  const latest = query.data?.probes[0] ?? mutation.data?.probe;
  return <div className="mt-3 space-y-2 text-[12px]">
    {isolated && access.can("resources", "operate") ? <>
      <p>验证会使用导致隔离的模型与当前凭证，只发送一个小请求；通过后恢复服务。</p>
      <label className="flex items-center gap-2"><input type="checkbox" checked={confirmed}
        disabled={mutation.isPending} onChange={e => setConfirmed(e.target.checked)} />允许本次验证消耗少量厂商额度</label>
      <button type="button" disabled={!confirmed || mutation.isPending}
        className="rounded border border-ql-action px-3 py-1.5 text-ql-action disabled:opacity-50"
        onClick={() => mutation.mutate()}>{mutation.isPending ? "正在验证…" : "验证当前凭证并恢复"}</button>
    </> : null}
    {latest ? <p role="status">{isolated && latest.status === "RECOVERED"
      ? "历史验证通过；当前资源已再次隔离" : labels[latest.status] ?? latest.status} · 模型 {latest.upstreamModel}
      {` · 凭证版本 ${latest.credentialVersion ?? "未知"} · ${formatDateTimeFull(latest.finishedAt ?? latest.startedAt)}`}
      {latest.httpStatus ? ` · HTTP ${latest.httpStatus}` : ""}
      {latest.status === "FAILED" ? `；可于 ${formatDateTimeFull(latest.retryAt)} 再次验证，持续鉴权失败请更新凭证` : ""}</p> : null}
    {mutation.error ? <p role="alert" className="text-ql-danger">{mutation.error.message}</p> : null}
    {query.error ? <p role="alert">验证记录暂时无法加载</p> : null}
  </div>;
}
