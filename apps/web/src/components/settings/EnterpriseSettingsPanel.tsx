import { useEffect, useState } from "react";
import { useEnterpriseSettings, useUpdateEnterpriseSettings } from "../../api/v2-hooks";
import { ErrorState } from "../states/ErrorState";
import { LoadingState } from "../states/LoadingState";

export function EnterpriseSettingsPanel() {
  const query = useEnterpriseSettings();
  const update = useUpdateEnterpriseSettings();
  const [name, setName] = useState(""); const [timezone, setTimezone] = useState("Asia/Shanghai"); const [currency, setCurrency] = useState("CNY");
  useEffect(() => { if (query.data) { setName(query.data.settings.name); setTimezone(query.data.settings.timezone); setCurrency(query.data.settings.default_currency); } }, [query.data]);
  if (query.isLoading) return <LoadingState label="正在读取企业设置…" rows={3}/>;
  if (query.error || !query.data) return <ErrorState message={query.error?.message ?? "企业设置加载失败"} onRetry={() => void query.refetch()}/>;
  const settings = query.data.settings;
  return <section className="max-w-3xl rounded-xl border border-ql-border-zone bg-ql-surface p-4"><h2 className="text-[15px] font-semibold">企业基础设置</h2><p className="mt-1 text-[12px] text-ql-fg-tertiary">时区决定今日、周一至周日和自然月边界；修改不改写已关闭账单。</p><div className="mt-4 grid gap-4 md:grid-cols-3"><label className="text-[12px] text-ql-fg-secondary">企业名称<input className="ql-input mt-1 w-full" maxLength={255} onChange={(event) => setName(event.target.value)} value={name}/></label><label className="text-[12px] text-ql-fg-secondary">企业时区<select className="ql-input mt-1 w-full" onChange={(event) => setTimezone(event.target.value)} value={timezone}><option value="Asia/Shanghai">Asia/Shanghai</option><option value="Asia/Hong_Kong">Asia/Hong_Kong</option><option value="Asia/Singapore">Asia/Singapore</option><option value="UTC">UTC</option></select></label><label className="text-[12px] text-ql-fg-secondary">默认货币<select className="ql-input mt-1 w-full" onChange={(event) => setCurrency(event.target.value)} value={currency}><option value="CNY">CNY</option><option value="USD">USD</option><option value="HKD">HKD</option><option value="SGD">SGD</option></select></label></div>{update.error ? <p className="mt-3 text-[12px] text-ql-danger">{update.error.message}</p> : null}<div className="mt-4 flex items-center justify-between"><span className="text-[11px] text-ql-fg-tertiary">版本 v{settings.version} · {new Date(settings.updated_at).toLocaleString("zh-CN")}</span><button className="h-9 rounded-lg bg-ql-action px-4 text-[13px] text-white disabled:opacity-50" disabled={!name.trim() || update.isPending} onClick={() => update.mutate({ expected_version: settings.version, name: name.trim(), timezone, default_currency: currency })} type="button">{update.isPending ? "保存中…" : "保存设置"}</button></div></section>;
}
