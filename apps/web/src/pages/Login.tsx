/**
 * W18 登录页 —— POST /auth/login（cookie 会话）。
 *
 * 视觉：canvas 底 + 居中 surface 卡片（表单主体 ≤640px，Web 规范 §8）；
 * 表单标签不只依赖 placeholder（§10 表单）。
 */
import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { useLocation, useNavigate } from "react-router-dom";

import qianliuLogo from "../assets/qianliu-logo-primary.png";
import { useAdminSession, useLogin } from "../api/auth";
import { ApiError } from "../api/client";
import { LoadingState } from "../components/states/LoadingState";

export function LoginPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const session = useAdminSession();
  const login = useLogin();

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");

  const from =
    typeof location.state === "object" && location.state !== null && "from" in location.state
      ? String((location.state as { from: unknown }).from)
      : "/dashboard";

  // 已登录直接进后台
  useEffect(() => {
    if (session.data) {
      navigate(from, { replace: true });
    }
  }, [session.data, navigate, from]);

  if (session.isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-ql-canvas">
        <LoadingState label="正在确认登录状态…" />
      </div>
    );
  }

  const errorMessage =
    login.error instanceof ApiError && login.error.status === 401
      ? "用户名或密码错误"
      : login.error
        ? login.error.message
        : null;

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    login.mutate(
      { username, password },
      {
        onSuccess: () => navigate(from, { replace: true }),
      },
    );
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-ql-canvas px-4">
      <div className="w-full max-w-sm rounded-2xl border border-ql-border bg-ql-surface p-8">
        <div className="mb-6 flex items-center gap-2">
          <span aria-hidden className="flex h-9 w-9 items-center justify-center overflow-hidden">
            <img className="h-12 w-12 max-w-none object-contain" src={qianliuLogo} />
          </span>
          <div>
            <h1 className="text-[18px] font-semibold leading-[26px] text-ql-fg">仟流智算</h1>
            <p className="text-[12px] leading-[18px] text-ql-fg-tertiary">管理后台</p>
          </div>
        </div>
        <form className="flex flex-col gap-4" onSubmit={handleSubmit}>
          <label className="flex flex-col gap-1.5">
            <span className="text-[13px] font-medium leading-5 text-ql-fg">用户名</span>
            <input
              autoComplete="username"
              className="h-10 rounded-lg border border-ql-border-strong bg-ql-surface px-3 text-[14px] text-ql-fg focus:outline focus:outline-2 focus:outline-offset-1 focus:outline-ql-action"
              onChange={(event) => setUsername(event.target.value)}
              required
              type="text"
              value={username}
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-[13px] font-medium leading-5 text-ql-fg">密码</span>
            <input
              autoComplete="current-password"
              className="h-10 rounded-lg border border-ql-border-strong bg-ql-surface px-3 text-[14px] text-ql-fg focus:outline focus:outline-2 focus:outline-offset-1 focus:outline-ql-action"
              onChange={(event) => setPassword(event.target.value)}
              required
              type="password"
              value={password}
            />
          </label>
          {errorMessage ? (
            <p className="rounded-lg bg-ql-danger-soft px-3 py-2 text-[13px] leading-5 text-ql-danger" role="alert">
              {errorMessage}
            </p>
          ) : null}
          <button
            className="mt-1 h-10 w-full rounded-lg bg-ql-action text-[14px] font-medium text-white hover:bg-ql-action-hover disabled:cursor-not-allowed disabled:opacity-60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ql-action"
            disabled={login.isPending}
            type="submit"
          >
            {login.isPending ? "正在登录…" : "登录"}
          </button>
        </form>
      </div>
    </div>
  );
}
