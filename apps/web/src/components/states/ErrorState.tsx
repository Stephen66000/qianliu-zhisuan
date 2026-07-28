/**
 * W18 错误态 —— danger 色 + 图标 + 文字 + 重试入口（Web 规范 §10）。
 *
 * 失败须说明原因和下一步，不只显示"处理失败"（Agent 规范 §9.2 失败语义）。
 */
import { CircleAlert, RotateCcw } from "lucide-react";

interface ErrorStateProps {
  /** 失败原因（后端 message 或归一化文案）。 */
  message: string;
  /** 重试入口（可选）。 */
  onRetry?: () => void;
}

export function ErrorState({ message, onRetry }: ErrorStateProps) {
  return (
    <div className="flex flex-col items-center gap-3 py-12 text-center" role="alert">
      <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-ql-danger-soft">
        <CircleAlert aria-hidden className="h-6 w-6 text-ql-danger" />
      </div>
      <p className="text-[14px] font-medium leading-[22px] text-ql-fg">加载失败</p>
      <p className="max-w-md text-[13px] leading-5 text-ql-fg-secondary">{message}</p>
      {onRetry ? (
        <button
          className="mt-1 flex h-9 items-center gap-2 rounded-lg border border-ql-border bg-ql-surface px-4 text-[14px] font-medium text-ql-fg hover:border-ql-border-strong focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ql-action"
          onClick={onRetry}
          type="button"
        >
          <RotateCcw aria-hidden className="h-4 w-4" />
          重试
        </button>
      ) : null}
    </div>
  );
}
