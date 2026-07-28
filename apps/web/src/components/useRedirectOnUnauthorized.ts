/**
 * W18 数据错误桥接 —— 页面内查询遇 401 时同步跳登录。
 *
 * TanStack Query 的错误在组件树内渲染，401 不属于业务错误态：
 * 会话已失效，继续展示重试无意义。本组件在 effect 中导航，避免渲染期副作用。
 */
import { useEffect } from "react";
import { useNavigate } from "react-router-dom";

import { UnauthorizedError } from "../api/client";

export function useRedirectOnUnauthorized(error: Error | null): void {
  const navigate = useNavigate();
  useEffect(() => {
    if (error instanceof UnauthorizedError) {
      navigate("/login", { replace: true });
    }
  }, [error, navigate]);
}
