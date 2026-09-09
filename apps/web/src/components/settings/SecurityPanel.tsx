import { useState } from "react";
import { useSecuritySettings, useSaveSecurity, useSessions, useRevokeSession, type SecuritySettings } from "../../api/settings";
import { useAccess } from "../../permissions";
export function SecurityPanel() {
  const query = useSecuritySettings();
  if (query.isLoading) return <p>正在读取登录策略…</p>;
  if (query.error || !query.data) return <p role="alert">{query.error?.message ?? "读取失败"}</p>;
  return <><SecurityForm key={query.data.settings.security_version} settings={query.data.settings} password={query.data.password_policy}/><SessionTable/></>;
}
function SecurityForm({ settings, password }: { settings: SecuritySettings; password: string }) {
  const [draft, setDraft] = useState(settings);
  const mutation = useSaveSecurity();
  const canEdit = useAccess().roleCode === "SUPER_ADMIN";
  return <form onSubmit={e => { e.preventDefault(); const { security_version, ...fields } = draft; mutation.mutate({ ...fields, expected_version: security_version }); }}>
    <h2 className="text-lg font-semibold">登录安全</h2>
    <div className="flex justify-between gap-4 border-b border-ql-border py-5"><span>密码要求</span><span>{password}</span></div>
    <fieldset disabled={!canEdit || mutation.isPending}>
      <label className="flex justify-between border-b border-ql-border py-5">首次登录修改密码<input type="checkbox" checked={draft.force_initial_password_change} onChange={e => setDraft({ ...draft, force_initial_password_change: e.target.checked })}/></label>
      <label className="flex justify-between border-b border-ql-border py-5">登录失败次数<input aria-label="登录失败次数" className="ql-input w-32" type="number" min={3} max={10} value={draft.login_max_failures} onChange={e => setDraft({ ...draft, login_max_failures: Number(e.target.value) })}/></label>
      <label className="flex justify-between border-b border-ql-border py-5">失败计数窗口（分钟）<input aria-label="失败计数窗口" className="ql-input w-32" type="number" min={5} max={60} value={draft.login_lock_minutes} onChange={e => setDraft({ ...draft, login_lock_minutes: Number(e.target.value) })}/></label>
      <label className="flex justify-between border-b border-ql-border py-5">会话有效期<select className="ql-input" value={draft.session_minutes} onChange={e => setDraft({ ...draft, session_minutes: Number(e.target.value) })}>{[15,30,60,120,480,1440].map(n => <option key={n} value={n}>{n < 60 ? n + " 分钟" : n / 60 + " 小时"}</option>)}</select></label>
      {canEdit && <div className="mt-5 text-right"><button className="rounded-lg bg-ql-action px-4 py-2 text-white">保存登录策略</button></div>}
    </fieldset>
    {mutation.error && <p role="alert" className="text-ql-danger">{mutation.error.message}</p>}
    {mutation.isSuccess && <p role="status">登录策略已保存</p>}
  </form>;
}
function SessionTable() {
  const query = useSessions(); const revoke = useRevokeSession(); const canEdit = useAccess().roleCode === "SUPER_ADMIN";
  return <section className="mt-8"><h2 className="mb-4 font-semibold">有效会话</h2>
    {query.error && <p role="alert">{query.error.message}</p>}
    <div className="overflow-auto"><table className="w-full text-left text-sm"><thead><tr><th>账号</th><th>设备</th><th>最近活动</th><th>操作</th></tr></thead><tbody>{query.data?.sessions.map(s => <tr key={s.id} className="border-b border-ql-border-zone">
      <td className="py-4">{s.display_name || s.username}</td><td className="max-w-xs break-words">{deviceName(s.user_agent)}</td><td>{s.last_seen_at ? new Date(s.last_seen_at).toLocaleString("zh-CN") : "未记录"}</td><td>{s.id === query.data.current_session_id ? "当前会话" : canEdit ? <button className="text-ql-danger" disabled={revoke.isPending} onClick={() => { if (window.confirm("结束该会话？该设备需要重新登录。")) revoke.mutate(s.id); }}>强制退出</button> : "—"}</td>
    </tr>)}</tbody></table></div>{revoke.error && <p role="alert">{revoke.error.message}</p>}
  </section>;
}
function deviceName(agent: string | null) {
  if (!agent) return "未记录";
  const browser = /Edg\//.test(agent) ? "Edge" : /Firefox\//.test(agent) ? "Firefox" : /Chrome\//.test(agent) ? "Chrome" : /Safari\//.test(agent) ? "Safari" : "其他客户端";
  const os = /Android/.test(agent) ? "Android" : /iPhone|iPad/.test(agent) ? "iOS" : /Windows/.test(agent) ? "Windows" : /Macintosh/.test(agent) ? "macOS" : /Linux/.test(agent) ? "Linux" : "未知系统";
  return browser + " · " + os;
}
