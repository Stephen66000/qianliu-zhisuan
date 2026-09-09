import { useState } from "react";
import { ADMIN_MODULES, type AdminPermissions } from "@qianliu/contracts";
import { useRole, useSaveRole, type CustomRole } from "../../api/settings";
import { useAccess } from "../../permissions";
export function RolePanel() {
  const query = useRole();
  const [selected, setSelected] = useState("CUSTOM");
  if (query.isLoading) return <p>正在读取角色…</p>;
  if (query.error) return <p role="alert">{query.error.message}</p>;
  return <div className="grid gap-6 md:grid-cols-[200px_1fr]">
    <div className="flex flex-col gap-2">{[["SUPER_ADMIN", "超级管理员"], ["CUSTOM", query.data?.role?.name || "自定义角色"]].map(([id, name]) =>
      <button type="button" key={id} className={"rounded-lg border p-3 text-left " + (selected === id ? "border-ql-action text-ql-action" : "border-ql-border")} onClick={() => setSelected(id!)}>{name}</button>)}</div>
    <RoleEditor key={selected + (query.data?.role?.version ?? 0)} role={query.data?.role ?? null} superRole={selected === "SUPER_ADMIN"}/>
  </div>;
}
function RoleEditor({ role, superRole }: { role: CustomRole | null; superRole: boolean }) {
  const [name, setName] = useState(role?.name ?? "");
  const [permissions, setPermissions] = useState<AdminPermissions>(role?.permissions ?? {});
  const save = useSaveRole();
  const editable = useAccess().roleCode === "SUPER_ADMIN" && !superRole;
  return <form onSubmit={e => { e.preventDefault(); save.mutate({ name: name.trim(), permissions, expected_version: role?.version ?? 0 }); }}>
    <h2 className="mb-4 text-lg font-semibold">{superRole ? "超级管理员" : "自定义角色"}</h2>
    {!superRole && <label className="mb-5 block max-w-md">岗位名称<input className="ql-input mt-2 w-full" required maxLength={128} value={name} disabled={!editable} onChange={e => setName(e.target.value)}/></label>}
    <table className="w-full text-left text-sm"><thead><tr className="border-b border-ql-border"><th className="p-3">功能模块</th><th>可查看</th><th>可操作</th></tr></thead><tbody>
      {ADMIN_MODULES.map(([id, title]) => <tr key={id} className="border-b border-ql-border-zone"><td className="p-3">{title}</td>{(["view", "operate"] as const).map(action => {
        const noWrite = ["dashboard", "usage", "audit", "version", "security", "admins"].includes(id);
        return <td key={action}><input type="checkbox" aria-label={title + (action === "view" ? "可查看" : "可操作")}
          checked={superRole || Boolean(permissions[id]?.[action])} disabled={!editable || (action === "operate" && (!permissions[id]?.view || noWrite))}
          onChange={e => setPermissions(old => ({ ...old, [id]: action === "view" ? { view: e.target.checked, operate: e.target.checked && Boolean(old[id]?.operate) } : { view: true, operate: e.target.checked } }))}/></td>;
      })}</tr>)}
    </tbody></table>
    {save.error && <p role="alert" className="mt-4 text-ql-danger">{save.error.message}</p>}
    {save.isSuccess && <p role="status">角色与权限已保存</p>}
    {editable && <div className="mt-5 text-right"><button className="rounded-lg bg-ql-action px-4 py-2 text-white disabled:opacity-50" disabled={!name.trim() || save.isPending}>保存角色与权限</button></div>}
  </form>;
}
