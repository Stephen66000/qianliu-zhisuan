/**
 * W19 使用主体 —— 列表 + 创建 + 停用（二次确认）。
 *
 * PRD §6：创建四步一期只落第一步（建主体）；Key/grant 在详情展开。
 * 停用 = PATCH status=DISABLED（后端级联撤销全部 Key，TRD §5.3），破坏性 → 二次确认。
 */
import { useState } from "react";
import { useForm } from "react-hook-form";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus, Users } from "lucide-react";
import { z } from "zod";
import { zodResolver } from "@hookform/resolvers/zod";

import { post, patch } from "../api/client";
import { QUERY_KEYS, usePrincipals } from "../api/hooks";
import type { Principal } from "../api/types";
import { PageShell } from "../components/layout/PageShell";
import { StatusTag } from "../components/dashboard/StatusTag";
import { QueryGate } from "../components/states/QueryGate";
import { ConfirmDialog } from "../components/writes/ConfirmDialog";
import { FormField, INPUT_CLASS } from "../components/writes/FormField";
import { useRedirectOnUnauthorized } from "../components/useRedirectOnUnauthorized";
import { formatDateTimeFull } from "../lib/format";

const CreatePrincipalSchema = z.object({
  type: z.enum(["EMPLOYEE", "PROJECT"]),
  name: z.string().min(1, "名称不能为空").max(255),
  department_label: z.string().max(255).optional(),
});

type CreatePrincipalValues = z.infer<typeof CreatePrincipalSchema>;

const TYPE_LABEL: Record<Principal["type"], string> = {
  EMPLOYEE: "员工",
  PROJECT: "项目",
};

export function PrincipalsPage() {
  const query = usePrincipals();
  useRedirectOnUnauthorized(query.error);
  const queryClient = useQueryClient();

  const [showCreate, setShowCreate] = useState(false);
  const [disableTarget, setDisableTarget] = useState<Principal | null>(null);

  const createMutation = useMutation({
    mutationFn: (values: CreatePrincipalValues) =>
      post<{ principal: Principal }>("/principals", values),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.principals });
      setShowCreate(false);
      reset();
    },
  });

  const disableMutation = useMutation({
    mutationFn: (target: Principal) =>
      patch<{ principal: Principal }>(`/principals/${target.id}`, { status: "DISABLED" }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.principals });
      setDisableTarget(null);
    },
  });

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<CreatePrincipalValues, unknown, CreatePrincipalValues>({
    resolver: zodResolver(CreatePrincipalSchema),
    defaultValues: { type: "EMPLOYEE", name: "", department_label: "" },
  });

  const principals = query.data?.principals ?? [];

  return (
    <PageShell
      description="员工与项目的统一主体管理；停用主体将同步撤销其全部 Key"
      title="使用主体"
    >
      <div className="mb-4 flex justify-end">
        <button
          className="flex h-9 items-center gap-1.5 rounded-lg bg-ql-action px-4 text-[14px] font-medium text-white hover:bg-ql-action-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ql-action"
          onClick={() => setShowCreate((v) => !v)}
          type="button"
        >
          <Plus aria-hidden className="h-4 w-4" />
          新建主体
        </button>
      </div>

      {showCreate ? (
        <form
          className="mb-5 flex flex-col gap-4 rounded-xl border border-ql-border bg-ql-surface-subtle p-4"
          onSubmit={handleSubmit((values) => createMutation.mutate(values))}
        >
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <FormField error={errors.type?.message} htmlFor="principal-type" label="类型">
              <select className={INPUT_CLASS} id="principal-type" {...register("type")}>
                <option value="EMPLOYEE">员工</option>
                <option value="PROJECT">项目</option>
              </select>
            </FormField>
            <FormField error={errors.name?.message} htmlFor="principal-name" label="名称">
              <input
                className={INPUT_CLASS}
                id="principal-name"
                placeholder="如：张三 / 数据平台项目组"
                {...register("name")}
              />
            </FormField>
            <FormField
              error={errors.department_label?.message}
              htmlFor="principal-dept"
              label="部门/标签（可选）"
            >
              <input
                className={INPUT_CLASS}
                id="principal-dept"
                placeholder="如：研发部"
                {...register("department_label")}
              />
            </FormField>
          </div>
          {createMutation.error ? (
            <p className="text-[13px] leading-5 text-ql-danger" role="alert">
              {createMutation.error.message}
            </p>
          ) : null}
          <div className="flex justify-end gap-2">
            <button
              className="h-9 rounded-lg border border-ql-border bg-ql-surface px-4 text-[14px] font-medium text-ql-fg hover:border-ql-border-strong"
              onClick={() => {
                setShowCreate(false);
                reset();
              }}
              type="button"
            >
              取消
            </button>
            <button
              className="h-9 min-w-[5.5rem] rounded-lg bg-ql-action px-4 text-[14px] font-medium text-white hover:bg-ql-action-hover disabled:cursor-not-allowed disabled:opacity-60"
              disabled={createMutation.isPending}
              type="submit"
            >
              {createMutation.isPending ? "创建中…" : "创建"}
            </button>
          </div>
        </form>
      ) : null}

      <QueryGate
        emptyDescription="尚未创建使用主体，也未生成主体 Key。点击右上角「新建主体」创建员工或项目。"
        emptyIcon={Users}
        emptyTitle="尚未创建使用主体"
        error={query.error}
        isEmpty={principals.length === 0}
        isLoading={query.isLoading}
        loadingRows={4}
        onRetry={() => void query.refetch()}
      >
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left">
            <thead>
              <tr className="border-b border-ql-border text-[12px] leading-[18px] text-ql-fg-tertiary">
                <th className="py-2 pr-4 font-medium">名称</th>
                <th className="py-2 pr-4 font-medium">类型</th>
                <th className="py-2 pr-4 font-medium">部门/标签</th>
                <th className="py-2 pr-4 font-medium">状态</th>
                <th className="py-2 pr-4 font-medium">创建时间</th>
                <th className="py-2 text-right font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {principals.map((p) => (
                <tr
                  className="border-b border-ql-border-zone text-[13px] leading-5 text-ql-fg last:border-b-0 hover:bg-ql-surface-subtle"
                  key={p.id}
                >
                  <td className="py-2.5 pr-4 font-medium">{p.name}</td>
                  <td className="py-2.5 pr-4 text-ql-fg-secondary">{TYPE_LABEL[p.type]}</td>
                  <td className="py-2.5 pr-4 text-ql-fg-secondary">{p.department_label ?? "—"}</td>
                  <td className="py-2.5 pr-4">
                    <StatusTag tone={p.status === "DISABLED" ? "danger" : "neutral"}>
                      {p.status === "DISABLED" ? "已停用" : "启用中"}
                    </StatusTag>
                  </td>
                  <td className="whitespace-nowrap py-2.5 pr-4 text-ql-fg-secondary">
                    {formatDateTimeFull(p.created_at)}
                  </td>
                  <td className="py-2.5 text-right">
                    {p.status !== "DISABLED" ? (
                      <button
                        className="rounded-md px-2 py-1 text-[12px] font-medium text-ql-danger hover:bg-ql-danger-soft focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ql-danger"
                        onClick={() => setDisableTarget(p)}
                        type="button"
                      >
                        停用
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </QueryGate>

      <ConfirmDialog
        danger
        confirmLabel="确认停用"
        impact={`停用后「${disableTarget?.name}」将无法调用任何模型，其全部有效 Key 将被同步撤销。该操作可通过重新启用恢复。`}
        loading={disableMutation.isPending}
        onCancel={() => setDisableTarget(null)}
        onConfirm={() => disableTarget && disableMutation.mutate(disableTarget)}
        open={disableTarget !== null}
        title="停用主体"
      />
    </PageShell>
  );
}
