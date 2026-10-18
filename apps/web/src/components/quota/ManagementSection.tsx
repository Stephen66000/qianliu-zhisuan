import { Button } from "../ui/Button";
import { Plus } from "lucide-react";
import type { ReactNode } from "react";

export function ManagementSection({
  title,
  actionLabel,
  actionDisabled = false,
  hint,
  onAction,
  children,
  hideAction = false,
}: {
  title: string;
  actionLabel: string;
  actionDisabled?: boolean;
  hint: string;
  onAction: () => void;
  children: ReactNode;
  hideAction?: boolean;
}) {
  return (
    <section className="mb-5 rounded-xl border border-ql-border bg-ql-surface p-4">
      <div className="mb-4 flex items-start justify-between gap-4">
        <div>
          <h2 className="text-[14px] font-semibold text-ql-fg">{title}</h2>
          <p className="mt-1 text-[13px] leading-5 text-ql-fg-secondary">{hint}</p>
        </div>
        {!hideAction ? <Button variant="secondary" size="sm"
          className="shrink-0"
          disabled={actionDisabled}
          onClick={onAction}
          type="button"
        >
          <Plus aria-hidden className="h-3.5 w-3.5" />
          {actionLabel}
        </Button> : null}
      </div>
      {children}
    </section>
  );
}
