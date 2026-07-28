/**
 * W19 写操作组件 —— 二次确认对话框（Web 规范 §10：破坏性操作必须二次确认并说明影响对象）。
 *
 * 视觉：surface-raised 浮层 + ql-shadow-raised + overlay 遮罩；
 * Danger 按钮仅在确认语境用红（§10 按钮）。
 */
import { TriangleAlert } from "lucide-react";
import { useEffect, useRef } from "react";
import type { ReactNode } from "react";

interface ConfirmDialogProps {
  open: boolean;
  /** 标题（说明动作）。 */
  title: string;
  /** 影响对象说明（必须具体，如"停用后张三将无法调用任何模型"）。 */
  impact: string;
  confirmLabel: string;
  cancelLabel?: string;
  /** 危险操作（红色确认按钮）。 */
  danger?: boolean;
  loading?: boolean;
  /** 附加内容（如恢复操作的轮换凭证选项），渲染在影响说明与按钮之间。 */
  children?: ReactNode;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  open,
  title,
  impact,
  confirmLabel,
  cancelLabel = "取消",
  danger = false,
  loading = false,
  children,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (open) {
      cancelRef.current?.focus();
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onCancel();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, onCancel]);

  if (!open) {
    return null;
  }

  return (
    <div
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-ql-canvas/60 p-4"
      onClick={onCancel}
      role="dialog"
    >
      <div
        className="w-full max-w-md rounded-2xl border border-ql-border bg-ql-surface-raised p-6 shadow-ql-raised"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start gap-3">
          <div
            className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${danger ? "bg-ql-danger-soft" : "bg-ql-warning-soft"}`}
          >
            <TriangleAlert
              aria-hidden
              className={`h-5 w-5 ${danger ? "text-ql-danger" : "text-ql-warning"}`}
            />
          </div>
          <div className="min-w-0">
            <h2 className="text-[16px] font-semibold leading-6 text-ql-fg">{title}</h2>
            <p className="mt-1 text-[13px] leading-5 text-ql-fg-secondary">{impact}</p>
          </div>
        </div>
        {children ? <div className="mt-4">{children}</div> : null}
        <div className="mt-6 flex justify-end gap-2">
          <button
            className="h-9 rounded-lg border border-ql-border bg-ql-surface px-4 text-[14px] font-medium text-ql-fg hover:border-ql-border-strong focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ql-action"
            disabled={loading}
            onClick={onCancel}
            ref={cancelRef}
            type="button"
          >
            {cancelLabel}
          </button>
          <button
            className={[
              "h-9 min-w-[5.5rem] rounded-lg px-4 text-[14px] font-medium text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2",
              danger
                ? "bg-ql-danger hover:opacity-90 focus-visible:outline-ql-danger"
                : "bg-ql-action hover:bg-ql-action-hover focus-visible:outline-ql-action",
              loading ? "cursor-not-allowed opacity-60" : "",
            ].join(" ")}
            disabled={loading}
            onClick={onConfirm}
            type="button"
          >
            {loading ? "处理中…" : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
