import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { useChangeOwnPassword } from "../api/admins";
import { ApiError } from "../api/client";

export function ChangePasswordPage() {
  const navigate = useNavigate();
  const mutation = useChangeOwnPassword();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const localError = newPassword !== confirmPassword && confirmPassword ? "两次输入的新密码不一致" : null;
  const apiError = mutation.error instanceof ApiError ? mutation.error.message : mutation.error?.message;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (localError) return;
    mutation.mutate({ current_password: currentPassword, new_password: newPassword }, {
      onSuccess: () => navigate("/login", { replace: true }),
    });
  };

  return (
    <div className="mx-auto max-w-xl rounded-xl border border-ql-border bg-ql-surface p-6">
      <h1 className="text-xl font-semibold">修改管理员密码</h1>
      <p className="mt-2 text-sm text-ql-fg-secondary">修改成功后所有现有会话立即失效，请使用新密码重新登录。</p>
      <form className="mt-6 flex flex-col gap-4" onSubmit={submit}>
        <label className="flex flex-col gap-1"><span className="text-sm">当前密码</span><input aria-label="当前密码" autoComplete="current-password" className="h-10 rounded-lg border border-ql-border-strong px-3" onChange={(e) => setCurrentPassword(e.target.value)} required type="password" value={currentPassword} /></label>
        <label className="flex flex-col gap-1"><span className="text-sm">新密码</span><input aria-label="新密码" autoComplete="new-password" className="h-10 rounded-lg border border-ql-border-strong px-3" onChange={(e) => setNewPassword(e.target.value)} required type="password" value={newPassword} /></label>
        <label className="flex flex-col gap-1"><span className="text-sm">确认新密码</span><input aria-label="确认新密码" autoComplete="new-password" className="h-10 rounded-lg border border-ql-border-strong px-3" onChange={(e) => setConfirmPassword(e.target.value)} required type="password" value={confirmPassword} /></label>
        <p className="text-xs text-ql-fg-secondary">需为 12～128 位，并同时包含大写字母、小写字母、数字和特殊字符。</p>
        {localError || apiError ? <p className="rounded-lg bg-ql-danger-soft px-3 py-2 text-sm text-ql-danger" role="alert">{localError ?? apiError}</p> : null}
        <button className="h-10 rounded-lg bg-ql-action font-medium text-white disabled:opacity-50" disabled={mutation.isPending || Boolean(localError)} type="submit">确认修改并重新登录</button>
      </form>
    </div>
  );
}
