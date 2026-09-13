import { useRole } from "../../api/settings";
export function AdminRoleField({ value, onChange, disabled = false }: { value: string; onChange: (v: "SUPER_ADMIN" | "CUSTOM") => void; disabled?: boolean }) {
  const query = useRole();
  const hasRole = Boolean(query.data?.role);
  return <select
    aria-label="角色"
    className="ql-input"
    value={value}
    disabled={disabled}
    title={!hasRole ? "自定义岗位尚未配置，请先前往角色与权限设置" : undefined}
    onChange={e => onChange(e.target.value as "SUPER_ADMIN" | "CUSTOM")}
  >
    <option value="SUPER_ADMIN">超级管理员</option>
    <option value="CUSTOM" disabled={!hasRole}>
      {query.data?.role?.name ?? "请先设置岗位名称"}
    </option>
  </select>;
}
