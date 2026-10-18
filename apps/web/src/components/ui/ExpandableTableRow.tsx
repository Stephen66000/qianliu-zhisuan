import { useId, useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { Button } from "./Button";

/** Parent keys include the data scope and stable business identity, so removed/changed rows never inherit expansion. */
export function ExpandableTableRow({ label, leading, children, details, columns }: {
  label: string; leading: ReactNode; children: ReactNode; details: ReactNode; columns: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const detailId = useId();
  return <>
    <tr className="border-b border-ql-border-zone align-top text-[13px] leading-5 text-ql-fg hover:bg-ql-surface-subtle">
      <td className="py-2.5 pr-3">
        <div className="flex items-start gap-1">
          <Button size="sm" variant="ghost" className="shrink-0" aria-label={`${expanded ? "收起" : "展开"}${label}详情`}
            aria-expanded={expanded} aria-controls={detailId} onClick={() => setExpanded(!expanded)}>
            {expanded ? <ChevronDown aria-hidden className="h-4 w-4" /> : <ChevronRight aria-hidden className="h-4 w-4" />}
          </Button>
          <div className="min-w-0 break-words pt-1.5">{leading}</div>
        </div>
      </td>
      {children}
    </tr>
    <tr hidden={!expanded} className="border-b border-ql-border-zone bg-ql-surface-subtle">
      <td colSpan={columns} className="p-4">
        <div id={detailId} role="region" aria-label={`${label}详情`}>
          <dl className="grid gap-x-6 gap-y-4 text-[13px] leading-5 sm:grid-cols-2 xl:grid-cols-3">{expanded ? details : null}</dl>
        </div>
      </td>
    </tr>
  </>;
}

export function RowDetail({ label, children }: { label: string; children: ReactNode }) {
  return <div className="min-w-0 break-words"><dt className="mb-1 text-ql-fg-tertiary">{label}</dt><dd className="text-ql-fg">{children}</dd></div>;
}
