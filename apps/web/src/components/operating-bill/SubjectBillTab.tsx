import { Info, Search } from "lucide-react";
import { useMemo, useState } from "react";

import { StatusTag } from "../dashboard/StatusTag";
import { BillCard, inputClass, SectionHeading } from "./BillShared";
import { employeeRows, projectRows } from "./prototype-data";

type SubjectType = "employee" | "project";

export function SubjectBillTab() {
  const [type, setType] = useState<SubjectType>("employee");
  const [keyword, setKeyword] = useState("");
  const rows = type === "employee" ? employeeRows : projectRows;
  const visibleRows = useMemo(
    () =>
      rows.filter((row) =>
        `${row.name}${row.note}${row.providers.join("")}`.includes(
          keyword.trim(),
        ),
      ),
    [keyword, rows],
  );

  return (
    <BillCard className="overflow-hidden">
      <SectionHeading
        action={
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex rounded-lg border border-ql-border bg-ql-surface-subtle p-1">
              {(["employee", "project"] as const).map((value) => (
                <button
                  aria-pressed={type === value}
                  className={`h-7 rounded-md px-3 text-[12px] font-medium ${
                    type === value
                      ? "bg-ql-surface text-ql-action shadow-sm"
                      : "text-ql-fg-secondary hover:text-ql-fg"
                  }`}
                  key={value}
                  onClick={() => setType(value)}
                  type="button"
                >
                  {value === "employee" ? "按员工" : "按项目"}
                </button>
              ))}
            </div>
            <label className="relative">
              <Search
                aria-hidden
                className="absolute left-3 top-2.5 h-4 w-4 text-ql-fg-tertiary"
              />
              <input
                aria-label="搜索员工、项目或厂商"
                className={`${inputClass} w-56 pl-9`}
                onChange={(event) => setKeyword(event.target.value)}
                placeholder="搜索名称或厂商"
                type="search"
                value={keyword}
              />
            </label>
          </div>
        }
        description="直接汇总主体成本，不再要求管理员逐条筛选请求"
        title={type === "employee" ? "员工汇总账" : "项目汇总账"}
      />

      <div className="mx-4 mb-3 flex items-start gap-2 rounded-lg bg-ql-surface-brand-soft px-3 py-2 text-[12px] leading-5 text-ql-fg-secondary">
        <Info aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-ql-action" />
        <span>
          API
          按实际调用成本归集；固定套餐按使用占比分摊，仅用于内部管理，不改变厂商账单。
        </span>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[54rem] text-left text-[13px]">
          <thead className="border-y border-ql-border-zone bg-ql-surface-subtle text-[12px] text-ql-fg-tertiary">
            <tr>
              <th className="px-4 py-2 font-medium">
                {type === "employee" ? "员工" : "项目"}
              </th>
              <th className="px-4 py-2 font-medium">使用厂商</th>
              <th className="px-4 py-2 text-right font-medium">Token</th>
              <th className="px-4 py-2 text-right font-medium">额度扣减</th>
              <th className="px-4 py-2 text-right font-medium">归集成本</th>
              <th className="px-4 py-2 font-medium">
                {type === "employee" ? "活跃天数" : "参与人数"}
              </th>
              <th className="px-4 py-2 font-medium">归属 / 价值</th>
            </tr>
          </thead>
          <tbody>
            {visibleRows.map((row) => (
              <tr
                className="border-b border-ql-border-zone last:border-0 hover:bg-ql-surface-subtle"
                key={row.name}
              >
                <td className="px-4 py-3 font-medium text-ql-fg">{row.name}</td>
                <td className="px-4 py-3">
                  <div className="flex flex-wrap gap-1">
                    {row.providers.map((provider) => (
                      <StatusTag key={provider}>{provider}</StatusTag>
                    ))}
                  </div>
                </td>
                <td className="px-4 py-3 text-right tabular-nums text-ql-fg-secondary">
                  {row.tokens}
                </td>
                <td className="px-4 py-3 text-right tabular-nums text-ql-fg-secondary">
                  {row.quota}
                </td>
                <td className="px-4 py-3 text-right font-medium tabular-nums text-ql-fg">
                  ¥{row.cost}
                </td>
                <td className="px-4 py-3 text-ql-fg-secondary">
                  {row.activity}
                </td>
                <td
                  className={`px-4 py-3 ${row.name === "未归属项目" ? "text-ql-warning" : "text-ql-fg-secondary"}`}
                >
                  {row.note}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot className="border-t border-ql-border bg-ql-surface-subtle font-medium text-ql-fg">
            <tr>
              <td className="px-4 py-3">合计</td>
              <td className="px-4 py-3 text-ql-fg-secondary">3 家厂商</td>
              <td className="px-4 py-3 text-right tabular-nums">74.2M</td>
              <td className="px-4 py-3 text-right tabular-nums">105.1M</td>
              <td className="px-4 py-3 text-right tabular-nums">¥1,800.00</td>
              <td className="px-4 py-3">
                {type === "employee" ? "16 人活跃" : "9 个项目"}
              </td>
              <td className="px-4 py-3 text-ql-fg-secondary">
                项目归属完整度 93%
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
    </BillCard>
  );
}
