/**
 * W18 通用查询三态闸门 —— loading / error / empty / success 一处收敛。
 *
 * 401 由调用侧（RequireAuth/页面）统一处理跳登录；这里只处理普通错误与空态。
 */
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

import { EmptyState } from "./EmptyState";
import { ErrorState } from "./ErrorState";
import { LoadingState } from "./LoadingState";

interface QueryGateProps {
  isLoading: boolean;
  error: Error | null;
  /** 空判定（如 list.length === 0）。 */
  isEmpty: boolean;
  emptyIcon: LucideIcon;
  emptyTitle: string;
  emptyDescription?: string;
  loadingLabel?: string;
  /** 骨架行数（>0 时用骨架屏占位）。 */
  loadingRows?: number;
  onRetry?: () => void;
  children: ReactNode;
}

export function QueryGate({
  isLoading,
  error,
  isEmpty,
  emptyIcon,
  emptyTitle,
  emptyDescription,
  loadingLabel,
  loadingRows = 0,
  onRetry,
  children,
}: QueryGateProps) {
  if (isLoading) {
    return <LoadingState label={loadingLabel} rows={loadingRows} />;
  }
  if (error) {
    return <ErrorState message={error.message} onRetry={onRetry} />;
  }
  if (isEmpty) {
    return <EmptyState description={emptyDescription} icon={emptyIcon} title={emptyTitle} />;
  }
  return <>{children}</>;
}
