import { useEffect, useState } from "react";
import { useAudit, type AuditItem } from "../../api/settings";
const actions: Record<string, string> = { "auth.login": "登录", "auth.logout": "退出登录", "enterprise_settings.update": "更新企业信息",
  "admin.create": "新增管理员", "admin.rename": "修改管理员名称", "admin.identity.update": "修改账号及角色", "admin.cleanup": "存档管理员",
  "admin.enable": "启用管理员", "admin.disable": "停用管理员", "admin.password.reset": "重置密码", "admin.password.change": "修改密码",
  "admin.role.update": "修改岗位权限", "security.settings.update": "修改登录策略", "admin.session.revoke": "结束会话", "alert.disposition": "处理异常" };
const objects: Record<string, string> = { enterprise: "企业信息", admin_user: "管理员", admin_role: "岗位权限", admin_session: "登录会话", principal: "使用主体", provider_resource: "厂商资源", alert: "异常", billing_rule: "计价规则" };
function summary(log: AuditItem) {
  if (log.result === "FAILURE") return log.failure_reason || "操作失败";
  const before = log.change_summary?.before; const after = log.change_summary?.after;
  if (before && after && typeof before === "object" && typeof after === "object") {
    const labels: Record<string, string> = { name: "名称", display_name: "显示名称", management_contact: "联系人", contact_email: "联系邮箱", timezone: "时区", default_currency: "币种", permissions: "模块权限", role_code: "角色", session_minutes: "会话时长", login_max_failures: "失败次数", login_lock_minutes: "计数窗口", force_initial_password_change: "首次改密" };
    return Object.keys(labels).filter(k => JSON.stringify((before as Record<string, unknown>)[k]) !== JSON.stringify((after as Record<string, unknown>)[k])).map(k => labels[k]).join("、") + "已更新";
  }
  return "操作已记录";
}
export function AuditPanel() {
  const [from, setFrom] = useState(""); const [to, setTo] = useState(""); const [actor, setActor] = useState("");
  const [result, setResult] = useState(""); const [search, setSearch] = useState(""); const [type, setType] = useState("");
  const [offset, setOffset] = useState(0); const [selected, setSelected] = useState<AuditItem | null>(null);
  useEffect(() => {
    if (!selected) return;
    const close = (e: KeyboardEvent) => { if (e.key === "Escape") setSelected(null); };
    document.addEventListener("keydown", close); return () => document.removeEventListener("keydown", close);
  }, [selected]);
  const params = new URLSearchParams({ limit: "50", offset: String(offset) });
  for (const [key, val] of Object.entries({ from, to, actor, result, search, target_type: type })) if (val) params.set(key, val);
  const query = useAudit(params);
  const date = (s: string) => new Date(s).toLocaleString("zh-CN", { timeZone: query.data?.timezone ?? "Asia/Shanghai" });
  const change = (setter: (v: string) => void, val: string) => { setter(val); setOffset(0); };
  return <section><h2 className="mb-5 text-lg font-semibold">审计日志</h2>
    <div className="mb-5 flex flex-wrap items-center gap-3">
      <label>开始日期<input type="date" className="ql-input ml-2" value={from} onChange={e => change(setFrom, e.target.value)}/></label>
      <label>结束日期<input type="date" className="ql-input ml-2" value={to} min={from} onChange={e => change(setTo, e.target.value)}/></label>
      <select className="ql-input" aria-label="操作人" value={actor} onChange={e => change(setActor, e.target.value)}><option value="">全部操作人</option>{query.data?.actors.map(a => <option key={a.id} value={a.id}>{a.display_name || a.username}</option>)}</select>
      <select className="ql-input" aria-label="操作结果" value={result} onChange={e => change(setResult, e.target.value)}><option value="">全部结果</option><option value="SUCCESS">成功</option><option value="FAILURE">失败</option></select>
      <select className="ql-input" aria-label="模块" value={type} onChange={e => change(setType, e.target.value)}><option value="">全部模块</option>{Object.entries(objects).map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select>
      <input aria-label="搜索日志" placeholder="搜索动作、对象、操作人" className="ql-input" value={search} onChange={e => change(setSearch, e.target.value)}/>
    </div>
    {query.error && <p role="alert" className="text-ql-danger">{query.error.message}</p>}
    {query.isLoading ? <p>正在读取日志…</p> : <div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr>{["时间", "操作人／来源", "动作", "对象／变更摘要", "结果", ""].map((h,i) => <th key={i} className="border-b border-ql-border p-3">{h}</th>)}</tr></thead><tbody>{query.data?.logs.map(log => <tr key={log.id} className="border-b border-ql-border-zone">
      <td className="p-3">{date(log.created_at)}</td><td>{log.actor_name || log.actor_username || "未记录"}<div className="text-xs text-ql-fg-tertiary">{{ ADMIN: "人工操作", SYSTEM: "系统任务" }[log.actor_source] ?? "来源未标注"}</div></td>
      <td>{actions[log.action] ?? objects[log.target_type] ?? "管理操作"}</td><td>{log.target_name || objects[log.target_type] || log.target_type}<div className="text-xs text-ql-fg-tertiary">{summary(log)}</div></td><td>{log.result === "SUCCESS" ? "成功" : "失败"}</td><td><button className="text-ql-action" onClick={() => setSelected(log)}>详情</button></td>
    </tr>)}</tbody></table>{query.data?.logs.length === 0 && <p className="py-8 text-center">暂无符合条件的记录</p>}</div>}
    <div className="mt-5 flex justify-between"><span>共 {query.data?.total ?? 0} 条</span><div className="flex gap-4"><button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 50))}>上一页</button><button disabled={offset + 50 >= (query.data?.total ?? 0)} onClick={() => setOffset(offset + 50)}>下一页</button></div></div>
    {selected && <div className="fixed inset-0 z-50 flex justify-end bg-black/30" onClick={() => setSelected(null)}><section role="dialog" aria-modal="true" aria-label="操作详情" className="h-full w-full max-w-xl overflow-auto bg-ql-surface p-6 shadow-xl" onClick={e => e.stopPropagation()}>
      <div className="mb-6 flex justify-between"><h2 className="text-lg font-semibold">操作详情</h2><button aria-label="关闭详情" onClick={() => setSelected(null)}>关闭</button></div>
      <dl className="grid grid-cols-[100px_1fr] gap-4"><dt>时间</dt><dd>{date(selected.created_at)}</dd><dt>操作人</dt><dd>{selected.actor_name || selected.actor_username || "未记录"}</dd><dt>动作</dt><dd>{actions[selected.action] ?? selected.action}</dd><dt>结果</dt><dd>{selected.result === "SUCCESS" ? "成功" : "失败"}</dd></dl>
      <h3 className="mt-6 font-semibold">变更详情</h3><div className="mt-3 grid grid-cols-2 gap-3">{["before", "after"].map(k => <div key={k}><h4>{k === "before" ? "修改前" : "修改后"}</h4><pre className="mt-2 whitespace-pre-wrap break-all text-xs">{JSON.stringify(selected.change_summary?.[k] ?? null, null, 2) ?? "未记录"}</pre></div>)}</div>
      {selected.failure_reason && <p className="mt-4 text-ql-danger">{selected.failure_reason}</p>}
      <details className="mt-6"><summary>原始记录</summary><pre className="whitespace-pre-wrap break-all text-xs">{JSON.stringify(selected, null, 2)}</pre></details>
    </section></div>}
  </section>;
}
