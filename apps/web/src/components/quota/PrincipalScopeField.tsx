import type { DispatchPolicy, Principal } from "../../api/types";
import { INPUT_CLASS } from "../writes/FormField";

function principalDisplayLabel(principal: Principal | undefined, id: string): string {
  return principal
    ? `${principal.name}（${principal.type === "EMPLOYEE" ? "员工" : "项目"}${principal.department_label ? ` · ${principal.department_label}` : ""}）`
    : `已删除主体（${id.slice(0, 8)}）`;
}

export function principalScopeText(ids: string[] | null, principalById: Map<string, Principal>): string {
  return ids?.length
    ? ids.map((id) => principalDisplayLabel(principalById.get(id), id)).join("、")
    : "全部主体";
}

export function policyTransitionImpact(
  target: { policy: DispatchPolicy; action: "publish" | "retire" | "restore" | "archive" } | null,
  principalById: Map<string, Principal>,
): string {
  if (!target) return "";
  if (target.action === "publish") {
    return `发布策略 ${target.policy.policyVersion} 后，新请求将立即执行 ${target.policy.action}；主体范围为 ${principalScopeText(target.policy.matchPrincipalScope, principalById)}。`;
  }
  if (target.action === "restore") {
    return `恢复策略 ${target.policy.policyVersion} 时将生成递增的新发布版本；历史版本保持 RETIRED。`;
  }
  return `停用策略 ${target.policy.policyVersion} 后，新请求将立即停止命中；历史决策不变。`;
}

interface Props {
  principals: Principal[];
  mode: "ALL" | "SELECTED";
  selectedIds: string[];
  search: string;
  error?: string;
  onSearch: (value: string) => void;
  onModeChange: (mode: "ALL" | "SELECTED") => void;
  onSelectedIdsChange: (ids: string[]) => void;
}

export function PrincipalScopeField(props: Props) {
  const principalById = new Map(props.principals.map((principal) => [principal.id, principal]));
  const query = props.search.trim().toLowerCase();
  const filtered = props.principals.filter((principal) => !query || [
    principal.name, principal.department_label ?? "", principal.type,
  ].some((value) => value.toLowerCase().includes(query)));
  return <div className="md:col-span-4 rounded-lg border border-ql-border-zone bg-ql-surface p-3">
    <div className="mb-2 flex items-center justify-between gap-3">
      <div><p className="text-[12px] font-medium text-ql-fg">主体范围</p>
        <p className="text-[11px] text-ql-fg-tertiary">按名称选择，系统只提交稳定主体 ID。</p></div>
      <input aria-label="搜索主体" className={`${INPUT_CLASS} w-56`}
        onChange={(event) => props.onSearch(event.target.value)} placeholder="搜索员工、项目或部门" value={props.search} />
    </div>
    <div className="mb-3 flex gap-4 text-[12px]">
      <label className="flex items-center gap-2"><input checked={props.mode === "ALL"}
        onChange={() => props.onModeChange("ALL")} type="radio" />全部主体</label>
      <label className="flex items-center gap-2"><input checked={props.mode === "SELECTED"}
        onChange={() => props.onModeChange("SELECTED")} type="radio" />指定主体</label>
    </div>
    {props.mode === "SELECTED" ? <>
      <div aria-label="主体选项" className="grid max-h-48 grid-cols-1 gap-2 overflow-y-auto rounded-lg bg-ql-surface-subtle p-3 md:grid-cols-2">
        {filtered.map((principal) => {
          const selected = props.selectedIds.includes(principal.id);
          const selectable = principal.status === "ACTIVE" && principal.archived_at === null;
          return <label className="flex items-start gap-2 text-[12px]" key={principal.id}>
            <input checked={selected} disabled={!selectable} onChange={(event) => {
              const next = event.target.checked
                ? [...props.selectedIds, principal.id]
                : props.selectedIds.filter((id) => id !== principal.id);
              props.onSelectedIdsChange([...new Set(next)]);
            }} type="checkbox" />
            <span>{principalDisplayLabel(principal, principal.id)}
              {!selectable ? <span className="ml-1 text-ql-warning">（已停用/归档，仅历史回显）</span> : null}
            </span>
          </label>;
        })}
      </div>
      <div className="mt-2 flex flex-wrap gap-1">{props.selectedIds.map((id) =>
        <span className="rounded bg-ql-surface-brand-soft px-2 py-1 text-[11px] text-ql-action" key={id}>
          {principalDisplayLabel(principalById.get(id), id)}
        </span>)}</div>
      {props.error ? <p className="mt-2 text-[11px] text-ql-danger" role="alert">{props.error}</p> : null}
    </> : <p className="text-[12px] text-ql-fg-secondary">该策略将匹配当前企业的全部主体。</p>}
  </div>;
}
