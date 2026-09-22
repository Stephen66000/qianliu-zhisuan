/**
 * 项目「成员与归集」页面（候选 C3 WP04；合同 11 §5）。
 * 成员表 + 加入/退出 + 权重意图（预览→发布）+ 核算生命周期；
 * 文案明确"依据管理规则归集，不代表实际工作内容""不设置规则仍可正常使用 AI"。
 */
import { useMemo, useState } from "react";
import { UsersRound } from "lucide-react";
import { useParams } from "react-router-dom";

import {
  useCreateProjectMembership, useEmployeesForMembership,
  usePreviewPolicyIntent, useProjectMemberships, usePublishPolicyIntent,
  useReviseAccountingLifecycle, useReviseProjectMembership,
} from "../api/project-allocation";
import { usePrincipals } from "../api/hooks";
import { EmptyState } from "../components/states/EmptyState";
import { ErrorState } from "../components/states/ErrorState";
import { LoadingState } from "../components/states/LoadingState";
import { useRedirectOnUnauthorized } from "../components/useRedirectOnUnauthorized";

function formatBps(bps: number | null): string {
  if (bps === null) return "—";
  return `${(bps / 100).toFixed(2)}%`;
}

function formatDate(iso: string | null): string {
  if (iso === null) return "开放";
  return new Date(iso).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });
}

function todayInput(): string {
  return new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
}

export function ProjectMembersPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const principalQuery = usePrincipals("exclude");
  const memberships = useProjectMemberships(projectId ?? "");
  const employees = useEmployeesForMembership();
  const createMembership = useCreateProjectMembership(projectId ?? "");
  const reviseMembership = useReviseProjectMembership(projectId ?? "");
  const previewIntent = usePreviewPolicyIntent(projectId ?? "");
  const publishIntent = usePublishPolicyIntent(projectId ?? "");
  const reviseLifecycle = useReviseAccountingLifecycle(projectId ?? "");
  useRedirectOnUnauthorized(memberships.error);

  const [employeeId, setEmployeeId] = useState("");
  const [joinedAt, setJoinedAt] = useState(todayInput());
  const [leftAt, setLeftAt] = useState("");
  const [weightBps, setWeightBps] = useState("");
  const [reason, setReason] = useState("");
  const [intentFor, setIntentFor] = useState<ProjectMembershipRowLike | null>(null);
  const [intentBps, setIntentBps] = useState("");
  const [message, setMessage] = useState<string | null>(null);

  const projectName = useMemo(() => {
    const found = principalQuery.data?.principals?.find((p) => p.id === projectId);
    return found?.name ?? projectId ?? "";
  }, [principalQuery.data, projectId]);
  void projectName;

  const previewData = previewIntent.data;

  type ProjectMembershipRowLike = {
    membershipId: string;
    employeePrincipalId: string;
    employeeName: string;
    revision: number;
    status: string;
    joinedAt: string;
    leftAt: string | null;
    currentWeightBps: number | null;
    weightInterval: { from: string; until: string | null } | null;
    otherProjectsCount: number;
    otherProjectsWeightBps: number;
  };

  if (memberships.isLoading) return <LoadingState />;
  if (memberships.isError) return <ErrorState message={(memberships.error as Error).message} />;
  const view = memberships.data;
  if (!view) return <EmptyState icon={UsersRound} title="未找到项目" />;

  return (
    <main className="mx-auto w-full max-w-6xl px-6 py-8">
      <div className="mb-2 flex items-baseline gap-3">
        <h1 className="text-xl font-semibold">成员与归集</h1>
        <span className="text-sm text-neutral-500">{projectName}</span>
      </div>
      <p className="mb-6 text-xs text-neutral-500">
        依据管理规则归集，不代表实际工作内容；不设置规则仍可正常使用 AI，用量进入未分配。
      </p>

      {message !== null && (
        <div className="mb-4 rounded border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-800">{message}</div>
      )}

      <section className="mb-8 rounded-lg border border-neutral-200 bg-white p-4">
        <h2 className="mb-3 text-sm font-semibold">添加成员</h2>
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-xs text-neutral-600">
            员工
            <select
              className="mt-1 block w-56 rounded border border-neutral-300 px-2 py-1.5 text-sm"
              value={employeeId}
              onChange={(event) => setEmployeeId(event.target.value)}
            >
              <option value="">选择员工</option>
              {(employees.data?.principals ?? []).map((employee) => (
                <option key={employee.id} value={employee.id}>{employee.name}</option>
              ))}
            </select>
          </label>
          <label className="text-xs text-neutral-600">
            加入日期
            <input
              type="date" value={joinedAt}
              className="mt-1 block rounded border border-neutral-300 px-2 py-1.5 text-sm"
              onChange={(event) => setJoinedAt(event.target.value)}
            />
          </label>
          <label className="text-xs text-neutral-600">
            退出日期（可选）
            <input
              type="date" value={leftAt}
              className="mt-1 block rounded border border-neutral-300 px-2 py-1.5 text-sm"
              onChange={(event) => setLeftAt(event.target.value)}
            />
          </label>
          <label className="text-xs text-neutral-600">
            权重 %（可选）
            <input
              type="number" min={0} max={100} step={0.01} value={weightBps}
              className="mt-1 block w-28 rounded border border-neutral-300 px-2 py-1.5 text-sm"
              onChange={(event) => setWeightBps(event.target.value)}
            />
          </label>
          <label className="text-xs text-neutral-600">
            原因
            <input
              type="text" value={reason}
              placeholder="例如：新成员加入项目"
              className="mt-1 block w-56 rounded border border-neutral-300 px-2 py-1.5 text-sm"
              onChange={(event) => setReason(event.target.value)}
            />
          </label>
          <button
            type="button" disabled={!employeeId || !reason || createMembership.isPending}
            className="rounded bg-neutral-900 px-3 py-1.5 text-sm text-white disabled:opacity-40"
            onClick={() => {
              createMembership.mutate({
                employeePrincipalId: employeeId,
                joinedAt,
                leftAt: leftAt === "" ? null : leftAt,
                ...(weightBps === "" ? {} : { weightBps: Math.round(Number(weightBps) * 100) }),
                reason,
                idempotencyKey: `ui-${employeeId}-${joinedAt}-${Date.now()}`,
              }, {
                onSuccess: () => setMessage("成员已加入"),
                onError: (error) => setMessage(`加入失败：${(error as Error).message}`),
              });
            }}
          >
            加入项目
          </button>
        </div>
        <p className="mt-2 text-xs text-neutral-500">
          当前成员 {view.counts.currentMembers} 人；填写权重即同时发布该项目权重段。
        </p>
      </section>

      <section className="mb-8 overflow-x-auto rounded-lg border border-neutral-200 bg-white">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-neutral-200 text-left text-xs text-neutral-500">
              <th className="px-4 py-2">员工</th>
              <th className="px-4 py-2">参与区间（北京时间）</th>
              <th className="px-4 py-2">状态</th>
              <th className="px-4 py-2">当前权重</th>
              <th className="px-4 py-2">其他项目占比</th>
              <th className="px-4 py-2">操作</th>
            </tr>
          </thead>
          <tbody>
            {view.rows.map((row) => (
              <tr key={row.membershipId} className="border-b border-neutral-100">
                <td className="px-4 py-2">{row.employeeName}</td>
                <td className="px-4 py-2 text-xs">
                  {formatDate(row.joinedAt)} → {formatDate(row.leftAt)}
                </td>
                <td className="px-4 py-2">{row.status === "ACTIVE" ? "参与中" : row.status === "FUTURE" ? "未开始" : "已结束"}</td>
                <td className="px-4 py-2">{formatBps(row.currentWeightBps)}</td>
                <td className="px-4 py-2 text-xs">
                  {row.otherProjectsCount} 个项目 / {formatBps(row.otherProjectsWeightBps)}
                </td>
                <td className="space-x-2 px-4 py-2 text-xs">
                  <button
                    type="button"
                    className="rounded border border-neutral-300 px-2 py-1"
                    onClick={() => setIntentFor(row)}
                  >
                    调整权重
                  </button>
                  <button
                    type="button" disabled={row.status !== "ACTIVE"}
                    className="rounded border border-neutral-300 px-2 py-1 disabled:opacity-40"
                    onClick={() => {
                      reviseMembership.mutate({
                        membershipId: row.membershipId,
                        expectedRevision: row.revision,
                        leftAt: todayInput(),
                        reason: "退出项目",
                        idempotencyKey: `ui-exit-${row.membershipId}-${Date.now()}`,
                      }, {
                        onSuccess: () => setMessage("已记录退出；今日仍有规则覆盖的用量按规则归集"),
                        onError: (error) => setMessage(`退出失败：${(error as Error).message}`),
                      });
                    }}
                  >
                    记录退出
                  </button>
                </td>
              </tr>
            ))}
            {view.rows.length === 0 && (
              <tr><td colSpan={6} className="px-4 py-6 text-center text-sm text-neutral-400">暂无成员</td></tr>
            )}
          </tbody>
        </table>
      </section>

      {intentFor !== null && (
        <section className="mb-8 rounded-lg border border-amber-200 bg-amber-50 p-4">
          <h2 className="mb-2 text-sm font-semibold">调整权重 — {intentFor.employeeName}</h2>
          <p className="mb-3 text-xs text-neutral-600">
            只提交本项目意图；隐藏项目不展示细节，余量按可用容量计算。
          </p>
          <div className="flex flex-wrap items-end gap-3">
            <label className="text-xs text-neutral-600">
              目标权重 %
              <input
                type="number" min={0} max={100} step={0.01} value={intentBps}
                className="mt-1 block w-28 rounded border border-neutral-300 px-2 py-1.5 text-sm"
                onChange={(event) => setIntentBps(event.target.value)}
              />
            </label>
            <button
              type="button" disabled={intentBps === "" || previewIntent.isPending}
              className="rounded border border-neutral-400 px-3 py-1.5 text-sm"
              onClick={() => {
                previewIntent.mutate({
                  employeePrincipalId: intentFor.employeePrincipalId,
                  expectedPolicyVersion: null,
                  segments: [{
                    validFrom: new Date().toISOString(),
                    validUntil: null,
                    weightBps: Math.round(Number(intentBps) * 100),
                  }],
                });
              }}
            >
              预览
            </button>
            {previewData && (
              <>
                <button
                  type="button" disabled={publishIntent.isPending
                    || previewData.conflicts.length > 0}
                  className="rounded bg-neutral-900 px-3 py-1.5 text-sm text-white disabled:opacity-40"
                  onClick={() => {
                    publishIntent.mutate({
                      employeePrincipalId: intentFor.employeePrincipalId,
                      expectedPolicyVersion: previewData.currentVersion,
                      reason: "项目页权重调整",
                      idempotencyKey: `ui-intent-${intentFor.membershipId}-${Date.now()}`,
                      segments: [{
                        validFrom: new Date().toISOString(),
                        validUntil: null,
                        weightBps: Math.round(Number(intentBps) * 100),
                      }],
                    }, {
                      onSuccess: () => {
                        setMessage("权重已发布");
                        setIntentFor(null);
                        previewIntent.reset();
                      },
                      onError: (error) => setMessage(`发布失败：${(error as Error).message}`),
                    });
                  }}
                >
                  发布
                </button>
              </>
            )}
          </div>
          {previewData && (
            <div className="mt-3 text-xs text-neutral-700">
              <p>
                可用容量 {previewData.hidden.availableBps / 100}%；
                本段后剩余 {previewData.segments[0]?.remainingBps !== undefined
                  ? previewData.segments[0].remainingBps / 100
                  : "—"}%
              </p>
              {previewData.conflicts.length > 0 && (
                <ul className="mt-1 list-disc pl-4 text-red-700">
                  {previewData.conflicts.map((conflict, index) => (
                    <li key={index}>
                      {conflict.message}
                      {conflict.totalBps !== null && conflict.totalBps !== undefined
                        ? `（合计 ${(conflict.totalBps / 100).toFixed(2)}%）`
                        : ""}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </section>
      )}

      <section className="rounded-lg border border-neutral-200 bg-white p-4">
        <h2 className="mb-2 text-sm font-semibold">核算生命周期</h2>
        <p className="mb-3 text-xs text-neutral-500">结束归集不撤销 Key、不改变调用权限；结束后项目直接调用仍如实显示。</p>
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-xs text-neutral-600">
            生效日期
            <input
              type="date" defaultValue={todayInput()}
              id="lifecycle-date"
              className="mt-1 block rounded border border-neutral-300 px-2 py-1.5 text-sm"
            />
          </label>
          <button
            type="button" disabled={reviseLifecycle.isPending}
            className="rounded border border-neutral-400 px-3 py-1.5 text-sm"
            onClick={() => {
              const input = document.getElementById("lifecycle-date") as HTMLInputElement | null;
              // 先取当前核算窗口版本：无配置时 0（开始核算），已有配置时用实际版本，
              // 否则服务端严格相等校验必然回 409 版本冲突，页面上的"结束核算"根本走不通。
              reviseLifecycle.mutate({
                effectiveAt: input?.value ?? todayInput(),
                reason: "页面操作核算生命周期",
                expectedVersion: memberships.data?.accountingProfile?.version ?? 0,
              }, {
                onSuccess: (data) => {
                  const mode = (data as { mode?: string }).mode === "ENDED" ? "结束" : "开始";
                  setMessage(`已${mode}核算`);
                  void memberships.refetch();
                },
                onError: (error) => setMessage(`操作失败：${(error as Error).message}`),
              });
            }}
          >
            设置核算起止
          </button>
        </div>
      </section>
    </main>
  );
}
