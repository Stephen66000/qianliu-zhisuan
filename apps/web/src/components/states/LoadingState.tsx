/**
 * W18 加载态 —— 骨架屏（surface-muted 底）+ 说明文字。
 *
 * 规范：Web §10 加载态（骨架屏或克制 spinner + 文字说明）、
 * 仪表盘补充：加载占位用 surface-muted，不放旋转图标冒充进度。
 */
import { Loader2 } from "lucide-react";

interface LoadingStateProps {
  /** 说明正在加载什么（不只显示旋转图标，Web 规范 §10）。 */
  label?: string;
  /** 骨架行数（区域占位用）。 */
  rows?: number;
}

export function LoadingState({ label = "正在加载数据…", rows = 0 }: LoadingStateProps) {
  if (rows > 0) {
    return (
      <div aria-busy="true" aria-label={label} className="flex flex-col gap-3">
        {Array.from({ length: rows }, (_, i) => (
          <div key={i} className="ql-skeleton h-12 w-full" />
        ))}
      </div>
    );
  }
  return (
    <div
      aria-busy="true"
      className="flex items-center justify-center gap-2 py-12 text-[13px] leading-5 text-ql-fg-secondary"
      role="status"
    >
      <Loader2 aria-hidden className="h-4 w-4 animate-spin text-ql-fg-tertiary" />
      <span>{label}</span>
    </div>
  );
}
