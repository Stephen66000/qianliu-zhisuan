import { Plus } from "lucide-react";
import type { ReactNode } from "react";

export function ManagementSection({
  title,
  actionLabel,
  actionDisabled = false,
  hint,
  onAction,
  children,
}: {
  title: string;
  actionLabel: string;
  actionDisabled?: boolean;
  hint: string;
  onAction: () => void;
  children: ReactNode;
}) {
  return (
    <section className="mb-5 rounded-xl border border-ql-border bg-ql-surface p-4">
      <div className="mb-4 flex items-start justify-between gap-4">
        <div>
          <h2 className="text-[14px] font-semibold text-ql-fg">{title}</h2>
          <p className="mt-1 text-[12px] leading-5 text-ql-fg-secondary">{hint}</p>
        </div>
        <button
          className="flex h-8 shrink-0 items-center gap-1 rounded-lg border border-ql-border px-3 text-[12px] font-medium text-ql-action hover:bg-ql-action-soft disabled:cursor-not-allowed disabled:opacity-50"
          disabled={actionDisabled}
          onClick={onAction}
          type="button"
        >
          <Plus aria-hidden className="h-3.5 w-3.5" />
          {actionLabel}
        </button>
      </div>
      {children}
    </section>
  );
}
