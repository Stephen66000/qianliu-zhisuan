import { useRole } from "../../api/settings";
export function AdminRoleField({ value, onChange, disabled = false }: { value: string; onChange: (v: "SUPER_ADMIN" | "CUSTOM") => void; disabled?: boolean }) {
  const query = useRole();
  return <select aria-label="角色" className="ql-input" value={value} disabled={disabled} onChange={e => onChange(e.target.value as "SUPER_ADMIN" | "CUSTOM")}>
    <option value="SUPER_ADMIN">超级管理员</option><option value="CUSTOM" disabled={!query.data?.role}>{query.data?.role?.name ?? "请先设置岗位名称"}</option>
  </select>;
}
