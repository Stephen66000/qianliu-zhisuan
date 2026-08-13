import { useState } from "react";
import { useFeatureFlags } from "../../feature-flags";
import { DepartmentBudgetPanel } from "./DepartmentBudgetPanel";

export function DepartmentBudgetEntry() {
  const flags = useFeatureFlags();
  const [expanded, setExpanded] = useState(false);
  if (!flags.FEATURE_DEPARTMENT_COST) return null;
  return <>
    <div className="mb-4 flex justify-end">
      <button className="rounded-lg border border-ql-border px-3 py-2 text-[12px] font-medium text-ql-action" onClick={() => setExpanded((value) => !value)} type="button">
        {expanded ? "收起部门预算" : "部门预算 · 2.0"}
      </button>
    </div>
    {expanded ? <DepartmentBudgetPanel /> : null}
  </>;
}
