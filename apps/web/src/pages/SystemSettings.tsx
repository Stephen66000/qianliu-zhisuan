import { useSearchParams } from "react-router-dom";
import { useAccess } from "../permissions";
import { PageShell } from "../components/layout/PageShell";
import { EnterpriseSettingsPanel } from "../components/settings/EnterpriseSettingsPanel";
import { RolePanel } from "../components/settings/RolePanel";
import { SecurityPanel } from "../components/settings/SecurityPanel";
import { AuditPanel } from "../components/settings/AuditPanel";
import { VersionPanel } from "../components/settings/VersionPanel";
import { AdminsPage } from "./Admins";
export function SystemSettingsPage() {
  const access = useAccess(); const [params, setParams] = useSearchParams();
  const tabs = [
    { id: "enterprise", name: "企业信息", allowed: access.can("enterprise") },
    { id: "accounts", name: "账号与安全", allowed: access.can("admins") || access.can("security") },
    { id: "audit", name: "审计日志", allowed: access.can("audit") },
    { id: "version", name: "关于版本", allowed: access.can("version") },
  ].filter(t => t.allowed);
  const tab = tabs.find(t => t.id === params.get("tab"))?.id ?? tabs[0]?.id;
  const subtabs = [{ id: "admins", name: "管理员", allowed: access.can("admins") }, { id: "roles", name: "角色与权限", allowed: access.can("admins") }, { id: "security", name: "登录安全", allowed: access.can("security") }].filter(t => t.allowed);
  const sub = subtabs.find(t => t.id === params.get("section"))?.id ?? subtabs[0]?.id;
  return <div className="settings-surface"><PageShell title="系统设置"><div className="mb-6 flex flex-wrap gap-6 border-b border-ql-border">{tabs.map(t => <button key={t.id} className={"border-b-2 px-2 py-4 " + (tab === t.id ? "border-ql-action font-semibold text-ql-action" : "border-transparent text-ql-fg-secondary")} onClick={() => setParams({ tab: t.id })}>{t.name}</button>)}</div>
    {!tab && <p>没有系统设置访问权限</p>}
    {tab === "enterprise" && <fieldset disabled={!access.can("enterprise", "operate")}><EnterpriseSettingsPanel/></fieldset>}
    {tab === "accounts" && <><div className="mb-5 flex gap-2">{subtabs.map(t => <button key={t.id} className={"rounded-lg px-4 py-2 " + (sub === t.id ? "bg-ql-surface-brand-soft text-ql-action" : "text-ql-fg-secondary")} onClick={() => setParams({ tab: "accounts", section: t.id })}>{t.name}</button>)}</div>{sub === "admins" ? <AdminsPage embedded/> : sub === "roles" ? <RolePanel/> : <SecurityPanel/>}</>}
    {tab === "audit" && <AuditPanel/>}{tab === "version" && <VersionPanel/>}
  </PageShell></div>;
}
