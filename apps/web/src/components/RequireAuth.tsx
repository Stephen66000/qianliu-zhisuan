/**
 * W18 认证闸门 —— 会话探测中显示加载态；未认证跳 /login；已认证渲染布局壳。
 */
import { Navigate, useLocation } from "react-router-dom";

import { useAdminSession } from "../api/auth";
import { UnauthorizedError } from "../api/client";
import { AppLayout } from "./layout/AppLayout";
import { ErrorState } from "./states/ErrorState";
import { LoadingState } from "./states/LoadingState";

export function RequireAuth() {
  const location = useLocation();
  const session = useAdminSession();

  if (session.isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-ql-canvas">
        <LoadingState label="正在确认登录状态…" />
      </div>
    );
  }

  if (session.error instanceof UnauthorizedError) {
    return <Navigate replace state={{ from: location.pathname }} to="/login" />;
  }

  if (session.error || !session.data) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-ql-canvas">
        <ErrorState
          message={session.error?.message ?? "无法确认登录状态"}
          onRetry={() => void session.refetch()}
        />
      </div>
    );
  }

  return <AppLayout admin={session.data.admin} />;
}
