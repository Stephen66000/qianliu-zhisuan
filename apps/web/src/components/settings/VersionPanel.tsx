import { useVersion } from "../../api/settings";
export function VersionPanel() {
  const query = useVersion();
  if (query.isLoading) return <p>正在读取版本…</p>;
  if (query.error || !query.data) return <p role="alert">{query.error?.message ?? "版本信息不可用"}</p>;
  const { product, version, releases } = query.data;
  return <section><h2 className="mb-5 text-lg font-semibold">关于版本</h2>
    <div className="mb-6 rounded-xl border border-ql-border bg-ql-surface-subtle p-5"><h3 className="text-xl font-semibold">{product}</h3><dl className="mt-3 flex gap-3"><dt>当前版本</dt><dd>{version ?? "当前构建未提供版本标识"}</dd></dl></div>
    <div className="grid gap-8 lg:grid-cols-2"><section><h3 className="mb-4 font-semibold">更新说明</h3>{releases.filter(r => r.status === "SUCCEEDED").map(r => <article key={r.id} className="border-b border-ql-border py-4"><h4 className="font-medium">{r.to_version || "版本未标注"}</h4><p className="mt-3 whitespace-pre-wrap">{r.summary}</p></article>)}</section>
      <section><h3 className="mb-4 font-semibold">升级历史</h3><table className="w-full text-left text-sm"><thead><tr><th>版本变化</th><th>时间</th><th>结果</th></tr></thead><tbody>{releases.map(r => <tr key={r.id} className="border-b border-ql-border"><td className="py-4">{r.from_version ?? "—"} → {r.to_version ?? "—"}</td><td>{new Date(r.started_at).toLocaleString("zh-CN")}</td><td>{{ SUCCEEDED: "成功", FAILED: "失败", ROLLED_BACK: "已回滚", IN_PROGRESS: "进行中" }[r.status] ?? r.status}</td></tr>)}</tbody></table></section></div>
    {!releases.length && <p className="py-6 text-ql-fg-tertiary">暂无升级记录</p>}
  </section>;
}
