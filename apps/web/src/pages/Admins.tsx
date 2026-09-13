import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { ShieldCheck, Trash2, UserPlus, X } from "lucide-react";
import {
  useAdmins,
  useCleanupAdmin,
  useCreateAdmin,
  useRenameAdmin,
  useResetAdminPassword,
  useSetAdminStatus,
} from "../api/admins";
import { INPUT_CLASS, BUTTON_CLASS, errorText } from "../components/settings/admin-display";
import { useAdminSession } from "../api/auth";
import { useRole } from "../api/settings";
import { PageShell } from "../components/layout/PageShell";
import { QueryGate } from "../components/states/QueryGate";
import { StatusTag } from "../components/dashboard/StatusTag";
import { AdminRoleField } from "../components/settings/AdminRoleField";

export function AdminsPage({ embedded = false }: { embedded?: boolean }) {
  const session = useAdminSession();
  const roleQuery = useRole();
  const customRole = roleQuery.data?.role;
  const [archived, setArchived] = useState(false);
  const [search, setSearch] = useState("");
  const [roleCode, setRoleCode] = useState<"SUPER_ADMIN" | "CUSTOM">("CUSTOM");
  const [roles, setRoles] = useState<Record<string, "SUPER_ADMIN" | "CUSTOM">>({});
  const query = useAdmins(archived);
  const canEdit = session.data?.admin.roleCode === "SUPER_ADMIN";
  const Container = embedded ? "div" : PageShell;
  const createAdmin = useCreateAdmin();
  const renameAdmin = useRenameAdmin();
  const resetPassword = useResetAdminPassword();
  const setStatus = useSetAdminStatus();
  const cleanupAdmin = useCleanupAdmin();
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [renames, setRenames] = useState<Record<string, string>>({});
  const [resetTarget, setResetTarget] = useState<string | null>(null);
  const [resetValue, setResetValue] = useState("");
  const [oneTimePassword, setOneTimePassword] = useState<{
    username: string;
    password: string;
  } | null>(null);
  const [cleanupTarget, setCleanupTarget] = useState<string | null>(null);

  const admins = (query.data?.admins ?? []).filter(a => (a.username + a.display_name).toLowerCase().includes(search.toLowerCase()));
  const currentId = session.data?.admin.adminUserId;
  const mutationError =
    errorText(createAdmin.error) ??
    errorText(renameAdmin.error) ??
    errorText(resetPassword.error) ??
    errorText(setStatus.error) ??
    errorText(cleanupAdmin.error);

  const submitCreate = (event: FormEvent) => {
    event.preventDefault();
    const submitted = { username, display_name: displayName, password, role_code: roleCode };
    createAdmin.mutate(submitted, {
      onSuccess: () => {
        setOneTimePassword({
          username: submitted.username,
          password: submitted.password,
        });
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
    resetPassword.mutate(
      { id: resetTarget, new_password: submittedPassword },
      {
        onSuccess: () => {
          setOneTimePassword({
            username: target.username,
            password: submittedPassword,
          });
          setResetTarget(null);
          setResetValue("");
        },
      },
    );
  };

  return (
    <Container title="管理员">
      <div className="mb-4 flex justify-end">
        <Link
          className="rounded-lg border border-ql-border-strong px-3 py-2 text-sm text-ql-fg-secondary hover:bg-ql-surface-subtle"
          to="/change-password"
        >
          修改我的密码
        </Link>
      </div>

      {oneTimePassword ? (
        <section
          className="mb-5 rounded-xl border border-ql-warning bg-ql-warning-soft p-4"
          role="status"
        >
          <h2 className="text-sm font-semibold text-ql-fg">一次性密码窗口</h2>
          <p className="mt-1 text-xs text-ql-fg-secondary">
            请安全交付给 {oneTimePassword.username}；刷新或清除后无法恢复。
          </p>
          <code className="mt-3 block select-all rounded-lg bg-ql-surface px-3 py-2 text-sm text-ql-fg">
            {oneTimePassword.password}
          </code>
          <button
            className="mt-3 text-sm text-ql-action"
            onClick={() => setOneTimePassword(null)}
            type="button"
          >
            清除明文
          </button>
        </section>
      ) : null}

      {canEdit && <section className="mb-6 rounded-xl border border-ql-border bg-ql-surface p-5">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <UserPlus className="h-5 w-5" />
            <h2 className="font-semibold">新增管理员</h2>
          </div>
          {customRole ? (
            <Link
              className="text-xs text-ql-action hover:underline"
              to="/settings?tab=accounts&section=roles"
            >
              配置「{customRole.name}」权限 →
            </Link>
          ) : (
            <Link
              className="inline-flex items-center gap-1 rounded-md bg-ql-surface-subtle px-2.5 py-1 text-xs text-ql-action hover:underline"
              to="/settings?tab=accounts&section=roles"
            >
              <span className="font-medium text-ql-action">尚未配置自定义岗位？</span>前往配置岗位与权限 →
            </Link>
          )}
        </div>
        <form className="grid gap-3 md:grid-cols-5" onSubmit={submitCreate}>
          <AdminRoleField value={roleCode} onChange={setRoleCode}/>
          <input
            aria-label="管理员用户名"
            className={INPUT_CLASS}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="用户名"
            required
            value={username}
          />
          <input
            aria-label="管理员显示名称"
            className={INPUT_CLASS}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="显示名称"
            required
            value={displayName}
          />
          <input
            aria-label="管理员初始密码"
            autoComplete="new-password"
            className={INPUT_CLASS}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="12 位以上强密码"
            required
            type="password"
            value={password}
          />
          <button
            className={BUTTON_CLASS}
            disabled={createAdmin.isPending}
            type="submit"
          >
            创建管理员
          </button>
        </form>
      </section>}

      <div className="mb-4 flex gap-3"><input aria-label="搜索管理员" className="ql-input" placeholder="搜索姓名或账号" value={search} onChange={e => setSearch(e.target.value)}/><select className="ql-input" aria-label="存档状态" value={String(archived)} onChange={e => setArchived(e.target.value === "true")}><option value="false">在用账号</option><option value="true">已存档账号</option></select></div>

      {mutationError ? (
        <p
          className="mb-4 rounded-lg bg-ql-danger-soft px-3 py-2 text-sm text-ql-danger"
          role="alert"
        >
          {mutationError}
        </p>
      ) : null}

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
            <thead>
              <tr className="border-b border-ql-border text-xs text-ql-fg-tertiary">
                <th className="p-3">用户名</th>
                <th className="p-3">显示名称</th>
                <th className="p-3">状态</th>
                <th className="p-3">首次改密</th>
                <th className="p-3">角色</th>
                <th className="p-3">最近登录</th>
                <th className="p-3">操作</th>
              </tr>
            </thead>
            <tbody>
              {admins.map((admin) => (
                <tr
                  className="border-b border-ql-border-zone last:border-0"
                  key={admin.id}
                >
                  <td className="p-3 font-medium">
                    {admin.username}
                    {admin.id === currentId ? "（当前）" : ""}
                  </td>
                  <td className="p-3">
                    <div className="flex min-w-52 gap-2">
                      <input
                        disabled={!canEdit || archived}
                        aria-label={`${admin.username} 显示名称`}
                        className={INPUT_CLASS}
                        onChange={(e) =>
                          setRenames((old) => ({
                            ...old,
                            [admin.id]: e.target.value,
                          }))
                        }
                        value={renames[admin.id] ?? admin.display_name}
                      />
                      <button
                        disabled={!canEdit || archived}
                        className="text-ql-action"
                        onClick={() =>
                          renameAdmin.mutate({
                            id: admin.id,
                            expected_version: admin.version,
                            role_code: roles[admin.id] ?? admin.role_code,
                            display_name:
                              renames[admin.id] ?? admin.display_name,
                          })
                        }
                        type="button"
                      >
                        保存
                      </button>
                    </div>
                  </td>
                  <td className="p-3">
                    <StatusTag
                      tone={admin.status === "ACTIVE" ? "success" : "neutral"}
                    >
                      {admin.status === "ACTIVE" ? "启用" : "停用"}
                    </StatusTag>
                  </td>
                  <td className="p-3">
                    {admin.must_change_password ? "是" : "否"}
                  </td>
                  <td className="p-3">
                    <AdminRoleField
                      value={roles[admin.id] ?? admin.role_code ?? "SUPER_ADMIN"}
                      disabled={!canEdit || archived || renameAdmin.isPending}
                      onChange={(newRole) => {
                        setRoles((old) => ({ ...old, [admin.id]: newRole }));
                        renameAdmin.mutate(
                          {
                            id: admin.id,
                            expected_version: admin.version,
                            role_code: newRole,
                            display_name:
                              renames[admin.id] ?? admin.display_name,
                          },
                          {
                            onError: () => {
                              setRoles((old) => {
                                const next = { ...old };
                                delete next[admin.id];
                                return next;
                              });
                            },
                          },
                        );
                      }}
                    />
                  </td>
                  <td className="p-3">{admin.last_login_at ? new Date(admin.last_login_at).toLocaleString("zh-CN") : "尚未记录"}</td>
                  <td className="p-3">
                    <div className="flex gap-3 whitespace-nowrap">
                      {canEdit && !archived && admin.id !== currentId ? (
                        <>
                          <button
                            className="text-ql-action"
                            onClick={() => {
                              setResetTarget(admin.id);
                              setResetValue("");
                            }}
                            type="button"
                          >
                            重置密码
                          </button>
                          <button
                            className={
                              admin.status === "ACTIVE"
                                ? "text-ql-danger"
                                : "text-ql-action"
                            }
                            onClick={() =>
                              setStatus.mutate({
                                id: admin.id,
                                status:
                                  admin.status === "ACTIVE"
                                    ? "DISABLED"
                                    : "ACTIVE",
                              })
                            }
                            type="button"
                          >
                            {admin.status === "ACTIVE" ? "停用" : "启用"}
                          </button>
                          {admin.status === "DISABLED" ? (
                            <button
                              className="inline-flex items-center gap-1 text-ql-danger"
                              onClick={() => setCleanupTarget(admin.id)}
                              type="button"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                              清理
                            </button>
                          ) : null}
                        </>
                      ) : (
                        <span className="text-ql-fg-tertiary">
                          {admin.id === currentId ? "请使用修改密码" : "—"}
                        </span>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </QueryGate>

      {resetTarget ? (
        <form
          className="mt-5 rounded-xl border border-ql-border bg-ql-surface p-5"
          onSubmit={submitReset}
        >
          <h2 className="font-semibold">
            重置 {admins.find((item) => item.id === resetTarget)?.username}{" "}
            的密码
          </h2>
          <p className="mt-1 text-xs text-ql-fg-secondary">
            保存后旧密码和现有会话立即失效，目标管理员首次登录必须修改密码。
          </p>
          <div className="mt-3 flex gap-3">
            <input
              aria-label="重置后的新密码"
              autoComplete="new-password"
              className={`${INPUT_CLASS} flex-1`}
              onChange={(e) => setResetValue(e.target.value)}
              required
              type="password"
              value={resetValue}
            />
            <button className={BUTTON_CLASS} type="submit">
              确认重置
            </button>
            <button
              className="px-3 text-sm"
              onClick={() => setResetTarget(null)}
              type="button"
            >
              取消
            </button>
          </div>
        </form>
      ) : null}

      {cleanupTarget ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4"
          role="presentation"
        >
          <section
            aria-labelledby="cleanup-admin-title"
            aria-modal="true"
            className="w-full max-w-md rounded-xl border border-ql-border bg-ql-surface p-5 shadow-xl"
            role="dialog"
          >
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2
                  className="font-semibold text-ql-fg"
                  id="cleanup-admin-title"
                >
                  确认清理管理员？
                </h2>
                <p className="mt-2 text-[13px] leading-5 text-ql-fg-secondary">
                  清理后，该账号将从管理员列表移除且不能再登录，现有会话立即失效；历史操作记录继续保留。
                </p>
              </div>
              <button
                aria-label="关闭清理确认"
                className="text-ql-fg-tertiary"
                onClick={() => setCleanupTarget(null)}
                type="button"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <p className="mt-4 rounded-lg bg-ql-surface-subtle px-3 py-2 text-sm font-medium text-ql-fg">
              {admins.find((item) => item.id === cleanupTarget)?.username}
              <span className="ml-2 font-normal text-ql-fg-secondary">
                {admins.find((item) => item.id === cleanupTarget)?.display_name}
              </span>
            </p>
            <div className="mt-5 flex justify-end gap-3">
              <button
                className="rounded-lg border border-ql-border-strong px-3 py-2 text-sm text-ql-fg"
                onClick={() => setCleanupTarget(null)}
                type="button"
              >
                取消
              </button>
              <button
                className="rounded-lg bg-ql-danger px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
                disabled={cleanupAdmin.isPending}
                onClick={() =>
                  cleanupAdmin.mutate(
                    { id: cleanupTarget },
                    { onSuccess: () => setCleanupTarget(null) },
                  )
                }
                type="button"
              >
                确认清理
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </Container>
  );
}
