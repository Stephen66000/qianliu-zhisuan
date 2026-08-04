import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { ShieldCheck, UserPlus } from "lucide-react";
import {
  useAdmins,
  useCreateAdmin,
  useRenameAdmin,
  useResetAdminPassword,
  useSetAdminStatus,
} from "../api/admins";
import { ApiError } from "../api/client";
import { useAdminSession } from "../api/auth";
import { PageShell } from "../components/layout/PageShell";
import { QueryGate } from "../components/states/QueryGate";
import { StatusTag } from "../components/dashboard/StatusTag";

const INPUT_CLASS =
  "h-10 rounded-lg border border-ql-border-strong bg-ql-surface px-3 text-sm text-ql-fg focus:outline focus:outline-2 focus:outline-offset-1 focus:outline-ql-action";
const BUTTON_CLASS =
  "h-9 rounded-lg bg-ql-action px-3 text-sm font-medium text-white hover:bg-ql-action-hover disabled:cursor-not-allowed disabled:opacity-50";

function errorText(error: unknown): string | null {
  return error instanceof ApiError ? error.message : error instanceof Error ? error.message : null;
}

export function AdminsPage() {
  const session = useAdminSession();
  const query = useAdmins();
  const createAdmin = useCreateAdmin();
  const renameAdmin = useRenameAdmin();
  const resetPassword = useResetAdminPassword();
  const setStatus = useSetAdminStatus();
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [renames, setRenames] = useState<Record<string, string>>({});
  const [resetTarget, setResetTarget] = useState<string | null>(null);
  const [resetValue, setResetValue] = useState("");
  const [oneTimePassword, setOneTimePassword] = useState<{ username: string; password: string } | null>(null);

  const admins = query.data?.admins ?? [];
  const currentId = session.data?.admin.adminUserId;
  const mutationError =
    errorText(createAdmin.error) ??
    errorText(renameAdmin.error) ??
    errorText(resetPassword.error) ??
    errorText(setStatus.error);

  const submitCreate = (event: FormEvent) => {
    event.preventDefault();
    const submitted = { username, display_name: displayName, password };
    createAdmin.mutate(submitted, {
      onSuccess: () => {
        setOneTimePassword({ username: submitted.username, password: submitted.password });
        setUsername("");
        setDisplayName("");
        setPassword("");
      },
    });
  };

  const submitReset = (event: FormEvent) => {
    event.preventDefault();
    const target = admins.find((item) => item.id === resetTarget);
    if (!target || !resetTarget) return;
    const submittedPassword = resetValue;
    resetPassword.mutate({ id: resetTarget, new_password: submittedPassword }, {
      onSuccess: () => {
        setOneTimePassword({ username: target.username, password: submittedPassword });
        setResetTarget(null);
        setResetValue("");
      },
    });
  };

  return (
    <PageShell description="同企业管理员账号、显示名称、状态与密码生命周期" title="管理员管理">
      <div className="mb-4 flex justify-end">
        <Link className="rounded-lg border border-ql-border-strong px-3 py-2 text-sm text-ql-fg-secondary hover:bg-ql-surface-subtle" to="/change-password">
          修改我的密码
        </Link>
      </div>

      {oneTimePassword ? (
        <section className="mb-5 rounded-xl border border-ql-warning bg-ql-warning-soft p-4" role="status">
          <h2 className="text-sm font-semibold text-ql-fg">一次性密码窗口</h2>
          <p className="mt-1 text-xs text-ql-fg-secondary">请安全交付给 {oneTimePassword.username}；刷新或清除后无法恢复。</p>
          <code className="mt-3 block select-all rounded-lg bg-ql-surface px-3 py-2 text-sm text-ql-fg">{oneTimePassword.password}</code>
          <button className="mt-3 text-sm text-ql-action" onClick={() => setOneTimePassword(null)} type="button">清除明文</button>
        </section>
      ) : null}

      <section className="mb-6 rounded-xl border border-ql-border bg-ql-surface p-5">
        <div className="mb-4 flex items-center gap-2"><UserPlus className="h-5 w-5" /><h2 className="font-semibold">新增管理员</h2></div>
        <form className="grid gap-3 md:grid-cols-4" onSubmit={submitCreate}>
          <input aria-label="管理员用户名" className={INPUT_CLASS} onChange={(e) => setUsername(e.target.value)} placeholder="用户名" required value={username} />
          <input aria-label="管理员显示名称" className={INPUT_CLASS} onChange={(e) => setDisplayName(e.target.value)} placeholder="显示名称" required value={displayName} />
          <input aria-label="管理员初始密码" autoComplete="new-password" className={INPUT_CLASS} onChange={(e) => setPassword(e.target.value)} placeholder="12 位以上强密码" required type="password" value={password} />
          <button className={BUTTON_CLASS} disabled={createAdmin.isPending} type="submit">创建管理员</button>
        </form>
      </section>

      {mutationError ? <p className="mb-4 rounded-lg bg-ql-danger-soft px-3 py-2 text-sm text-ql-danger" role="alert">{mutationError}</p> : null}

      <QueryGate
        emptyDescription="创建第二个管理员以避免管理单点。"
        emptyIcon={ShieldCheck}
        emptyTitle="暂无管理员"
        error={query.error}
        isEmpty={admins.length === 0}
        isLoading={query.isLoading}
        onRetry={() => void query.refetch()}
      >
        <div className="overflow-x-auto rounded-xl border border-ql-border bg-ql-surface">
          <table className="w-full text-left text-sm">
            <thead><tr className="border-b border-ql-border text-xs text-ql-fg-tertiary"><th className="p-3">用户名</th><th className="p-3">显示名称</th><th className="p-3">状态</th><th className="p-3">首次改密</th><th className="p-3">操作</th></tr></thead>
            <tbody>
              {admins.map((admin) => (
                <tr className="border-b border-ql-border-zone last:border-0" key={admin.id}>
                  <td className="p-3 font-medium">{admin.username}{admin.id === currentId ? "（当前）" : ""}</td>
                  <td className="p-3"><div className="flex min-w-52 gap-2"><input aria-label={`${admin.username} 显示名称`} className={INPUT_CLASS} onChange={(e) => setRenames((old) => ({ ...old, [admin.id]: e.target.value }))} value={renames[admin.id] ?? admin.display_name} /><button className="text-ql-action" onClick={() => renameAdmin.mutate({ id: admin.id, display_name: renames[admin.id] ?? admin.display_name })} type="button">保存</button></div></td>
                  <td className="p-3"><StatusTag tone={admin.status === "ACTIVE" ? "success" : "neutral"}>{admin.status === "ACTIVE" ? "启用" : "停用"}</StatusTag></td>
                  <td className="p-3">{admin.must_change_password ? "是" : "否"}</td>
                  <td className="p-3"><div className="flex gap-3 whitespace-nowrap">{admin.id !== currentId ? <><button className="text-ql-action" onClick={() => { setResetTarget(admin.id); setResetValue(""); }} type="button">重置密码</button><button className={admin.status === "ACTIVE" ? "text-ql-danger" : "text-ql-action"} onClick={() => setStatus.mutate({ id: admin.id, status: admin.status === "ACTIVE" ? "DISABLED" : "ACTIVE" })} type="button">{admin.status === "ACTIVE" ? "停用" : "启用"}</button></> : <span className="text-ql-fg-tertiary">请使用修改密码</span>}</div></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </QueryGate>

      {resetTarget ? (
        <form className="mt-5 rounded-xl border border-ql-border bg-ql-surface p-5" onSubmit={submitReset}>
          <h2 className="font-semibold">重置 {admins.find((item) => item.id === resetTarget)?.username} 的密码</h2>
          <p className="mt-1 text-xs text-ql-fg-secondary">保存后旧密码和现有会话立即失效，目标管理员首次登录必须修改密码。</p>
          <div className="mt-3 flex gap-3"><input aria-label="重置后的新密码" autoComplete="new-password" className={`${INPUT_CLASS} flex-1`} onChange={(e) => setResetValue(e.target.value)} required type="password" value={resetValue} /><button className={BUTTON_CLASS} type="submit">确认重置</button><button className="px-3 text-sm" onClick={() => setResetTarget(null)} type="button">取消</button></div>
        </form>
      ) : null}
    </PageShell>
  );
}
