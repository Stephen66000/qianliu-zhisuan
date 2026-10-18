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
import { PageShell } from "../components/layout/PageShell";
import { EmptyState } from "../components/states/EmptyState";
import { ErrorState } from "../components/states/ErrorState";
import { LoadingState } from "../components/states/LoadingState";
import { Button } from "../components/ui/Button";
import { useRedirectOnUnauthorized } from "../components/useRedirectOnUnauthorized";

/** 页面内分区（PageShell 内容区里的浅底分组，不再套白底卡片）。 */
const ZONE_CLASS = "rounded-xl border border-ql-border-zone bg-ql-surface-subtle p-4";
const LABEL_CLASS = "text-[13px] text-ql-fg-secondary";
const FIELD_CLASS = "mt-1 block h-9 rounded-lg border border-ql-border-strong bg-ql-surface px-3 text-sm text-ql-fg";

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

  const shell = {
    title: "成员与归集",
    meta: projectName,
    description: "依据管理规则归集，不代表实际工作内容；不设置规则仍可正常使用 AI，用量进入未分配。",
  };
  if (memberships.isLoading) return <PageShell {...shell}><LoadingState /></PageShell>;
  if (memberships.isError) {
    return <PageShell {...shell}><ErrorState message={(memberships.error as Error).message} /></PageShell>;
  }
  const view = memberships.data;
  if (!view) return <PageShell {...shell}><EmptyState icon={UsersRound} title="未找到项目" /></PageShell>;

  return (
    <PageShell {...shell}>
      <div className="flex flex-col gap-5">
        {message !== null && (
          <div className="rounded-lg bg-ql-action-soft px-3 py-2 text-sm text-ql-action-hover">{message}</div>
        )}

        <section className={ZONE_CLASS}>
          <h2 className="mb-3 text-[15px] font-semibold text-ql-fg">添加成员</h2>
          <div className="flex flex-wrap items-end gap-3">
            <label className={LABEL_CLASS}>
              员工
              <select
                className={`${FIELD_CLASS} w-56`}
                value={employeeId}
                onChange={(event) => setEmployeeId(event.target.value)}
              >
                <option value="">选择员工</option>
                {(employees.data?.principals ?? []).map((employee) => (
                  <option key={employee.id} value={employee.id}>{employee.name}</option>
                ))}
              </select>
            </label>
            <label className={LABEL_CLASS}>
              加入日期
              <input
                type="date" value={joinedAt}
                className={FIELD_CLASS}
                onChange={(event) => setJoinedAt(event.target.value)}
              />
            </label>
            <label className={LABEL_CLASS}>
              退出日期（可选）
              <input
                type="date" value={leftAt}
                className={FIELD_CLASS}
                onChange={(event) => setLeftAt(event.target.value)}
              />
            </label>
            <label className={LABEL_CLASS}>
              权重 %（可选）
              <input
                type="number" min={0} max={100} step={0.01} value={weightBps}
                className={`${FIELD_CLASS} w-28`}
                onChange={(event) => setWeightBps(event.target.value)}
              />
            </label>
            <label className={LABEL_CLASS}>
              原因
              <input
                type="text" value={reason}
                placeholder="例如：新成员加入项目"
                className={`${FIELD_CLASS} w-56`}
                onChange={(event) => setReason(event.target.value)}
              />
            </label>
            <Button
              disabled={!employeeId || !reason || createMembership.isPending}
              variant="primary"
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
            </Button>
          </div>
          <p className="mt-2 text-[13px] text-ql-fg-secondary">
            当前成员 {view.counts.currentMembers} 人；填写权重即同时发布该项目权重段。
          </p>
        </section>

        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left text-sm">
            <thead>
              <tr className="border-b border-ql-border text-[13px] text-ql-fg-tertiary">
                <th className="px-3 py-2 font-medium">员工</th>
                <th className="px-3 py-2 font-medium">参与区间（北京时间）</th>
                <th className="px-3 py-2 font-medium">状态</th>
                <th className="px-3 py-2 font-medium">当前权重</th>
                <th className="px-3 py-2 font-medium">其他项目占比</th>
                <th className="px-3 py-2 font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {view.rows.map((row) => (
                <tr key={row.membershipId} className="border-b border-ql-border text-ql-fg">
                  <td className="px-3 py-2">{row.employeeName}</td>
                  <td className="px-3 py-2 text-[13px] text-ql-fg-secondary">
                    {formatDate(row.joinedAt)} → {formatDate(row.leftAt)}
                  </td>
                  <td className="px-3 py-2">{row.status === "ACTIVE" ? "参与中" : row.status === "FUTURE" ? "未开始" : "已结束"}</td>
                  <td className="px-3 py-2 tabular-nums">{formatBps(row.currentWeightBps)}</td>
                  <td className="px-3 py-2 text-[13px] text-ql-fg-secondary">
                    {row.otherProjectsCount} 个项目 / {formatBps(row.otherProjectsWeightBps)}
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex gap-2">
                      <Button size="sm" onClick={() => setIntentFor(row)}>
                        调整权重
                      </Button>
                      <Button
                        disabled={row.status !== "ACTIVE"}
                        size="sm"
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
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
              {view.rows.length === 0 && (
                <tr><td colSpan={6} className="px-3 py-6 text-center text-sm text-ql-fg-tertiary">暂无成员</td></tr>
              )}
            </tbody>
          </table>
        </div>

        {intentFor !== null && (
          <section className="rounded-xl border border-ql-border-zone bg-ql-surface-brand-soft p-4">
            <h2 className="mb-2 text-[15px] font-semibold text-ql-fg">调整权重 — {intentFor.employeeName}</h2>
            <p className="mb-3 text-[13px] text-ql-fg-secondary">
              只提交本项目意图；隐藏项目不展示细节，余量按可用容量计算。
            </p>
            <div className="flex flex-wrap items-end gap-3">
              <label className={LABEL_CLASS}>
                目标权重 %
                <input
                  type="number" min={0} max={100} step={0.01} value={intentBps}
                  className={`${FIELD_CLASS} w-28`}
                  onChange={(event) => setIntentBps(event.target.value)}
                />
              </label>
              <Button
                disabled={intentBps === "" || previewIntent.isPending}
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
              </Button>
              {previewData && (
                <Button
                  disabled={publishIntent.isPending || previewData.conflicts.length > 0}
                  variant="primary"
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
                </Button>
              )}
            </div>
            {previewData && (
              <div className="mt-3 text-[13px] text-ql-fg-secondary">
                <p>
                  可用容量 {previewData.hidden.availableBps / 100}%；
                  本段后剩余 {previewData.segments[0]?.remainingBps !== undefined
                    ? previewData.segments[0].remainingBps / 100
                    : "—"}%
                </p>
                {previewData.conflicts.length > 0 && (
                  <ul className="mt-1 list-disc pl-4 text-ql-danger">
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

        <section className={ZONE_CLASS}>
          <h2 className="mb-2 text-[15px] font-semibold text-ql-fg">核算生命周期</h2>
          <p className="mb-3 text-[13px] text-ql-fg-secondary">结束归集不撤销 Key、不改变调用权限；结束后项目直接调用仍如实显示。</p>
          <div className="flex flex-wrap items-end gap-3">
            <label className={LABEL_CLASS}>
              生效日期
              <input
                type="date" defaultValue={todayInput()}
                id="lifecycle-date"
                className={FIELD_CLASS}
              />
            </label>
            <Button
              disabled={reviseLifecycle.isPending}
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
            </Button>
          </div>
        </section>
      </div>
    </PageShell>
  );
}
