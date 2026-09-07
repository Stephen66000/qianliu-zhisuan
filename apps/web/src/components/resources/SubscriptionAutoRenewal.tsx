import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { get, post } from "../../api/client";
import { formatMoney, formatShanghaiDate } from "../../lib/format";

interface AutoRenewal {
  enabled: boolean; nextRenewalAt: string | null; amount: string | null; currency: string | null;
  cashPaidCny: string | null; productName: string | null; blockedReason: string | null;
}
export function SubscriptionAutoRenewal({ resourceId, writable }: { resourceId: string; writable: boolean }) {
  const client = useQueryClient();
  const key = ["provider-finance", "auto-renewal", resourceId];
  const query = useQuery({ queryKey: key, queryFn: ({ signal }) =>
    get<AutoRenewal>(`/provider-resources/${resourceId}/finance/auto-renewal`, signal), staleTime: 0,
    refetchInterval: 30_000, refetchIntervalInBackground: false });
  const cancel = useMutation({ mutationFn: () => post(`/provider-resources/${resourceId}/finance/auto-renewal/cancel`, {}),
    onSuccess: () => { void client.invalidateQueries({ queryKey: ["provider-finance"] }); } });
  if (query.isLoading) return <p className="text-[12px] text-ql-fg-tertiary">正在读取自动续订…</p>;
  if (!query.data) return <p role="alert" className="text-[12px] text-ql-danger">{query.error?.message ?? "自动续订状态读取失败"}</p>;
  const data = query.data;
  return <div className="mt-3 flex flex-wrap items-center gap-3 rounded-lg border border-ql-border p-3 text-[12px]">
    <span className="font-medium">自动续订：{data.enabled ? "已开启" : "已取消"}</span>
    {data.enabled && data.nextRenewalAt ? <span>下次 {formatShanghaiDate(data.nextRenewalAt)}{data.cashPaidCny ? ` · ¥${formatMoney(data.cashPaidCny)}` : ""}</span> : null}
    {data.enabled && data.blockedReason ? <span role="status" className="text-ql-warning">{data.blockedReason}</span> : null}
    {data.enabled ? <button type="button" className="ml-auto rounded border border-ql-border px-3 py-1.5 text-ql-danger disabled:opacity-50"
      disabled={!writable || cancel.isPending} onClick={() => cancel.mutate()}>{cancel.isPending ? "取消中…" : "取消自动续订"}</button> : <span className="text-ql-fg-tertiary">本期和历史记录保留</span>}
    {cancel.error ? <span role="alert" className="w-full text-ql-danger">{cancel.error.message}</span> : null}
  </div>;
}
