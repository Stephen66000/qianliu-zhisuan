import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { get, put } from "../../api/client";
import type { Principal } from "../../api/types";
import { INPUT_CLASS } from "../writes/FormField";

interface Profile {
  assignment: null | {
    departmentId: string | null;
    ownerPrincipalId: string | null;
    version: number;
  };
  departments: Array<{ id: string; name: string }>;
  employees: Array<{ id: string; name: string }>;
}
export function PrincipalAccountingPanel({
  principal,
  onClose,
}: {
  principal: Principal;
  onClose: () => void;
}) {
  const client = useQueryClient();
  const query = useQuery({
    queryKey: ["principal-accounting", principal.id],
    queryFn: ({ signal }) =>
      get<Profile>(`/principals/${principal.id}/accounting-profile`, signal),
  });
  const [department, setDepartment] = useState(""),
    [name, setName] = useState(""),
    [owner, setOwner] = useState("");
  useEffect(() => {
    if (query.data) {
      setDepartment(query.data.assignment?.departmentId ?? "");
      setOwner(query.data.assignment?.ownerPrincipalId ?? "");
      setName(principal.department_label ?? "");
    }
  }, [query.data, principal.department_label]);
  const mutation = useMutation({
    mutationFn: () =>
      put(`/principals/${principal.id}/accounting-profile`, {
        expected_version: query.data?.assignment?.version ?? 0,
        ...(principal.type === "EMPLOYEE"
          ? department
            ? { department_id: department }
            : { department_name: name.trim() }
          : { owner_principal_id: owner }),
      }),
    onSuccess: () => {
      void client.invalidateQueries({
        predicate: (q) =>
          String(q.queryKey[0]).startsWith("principal") ||
          String(q.queryKey[0]).startsWith("operating"),
      });
      onClose();
    },
  });
  return (
    <section className="rounded-xl border border-ql-border bg-ql-surface p-4">
      <h2 className="mb-3 text-[16px] font-semibold">
        {principal.name} ·{" "}
        {principal.type === "EMPLOYEE" ? "所属部门" : "项目负责人"}
      </h2>
      {query.isLoading ? (
        <p>正在读取归属…</p>
      ) : query.error ? (
        <p role="alert">{query.error.message}</p>
      ) : (
        <>
          {principal.type === "EMPLOYEE" ? (
            <div className="flex flex-wrap gap-3">
              <label>
                所属部门
                <select
                  aria-label="所属部门"
                  className={`${INPUT_CLASS} ml-2`}
                  value={department}
                  onChange={(event) => setDepartment(event.target.value)}
                >
                  <option value="">填写部门名称</option>
                  {query.data?.departments.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
                </select>
              </label>
              {!department ? (
                <input
                  aria-label="部门名称"
                  className={INPUT_CLASS}
                  value={name}
                  maxLength={255}
                  placeholder="如：研发部"
                  onChange={(event) => setName(event.target.value)}
                />
              ) : null}
            </div>
          ) : (
            <label>
              项目负责人
              <select
                aria-label="项目负责人"
                className={`${INPUT_CLASS} ml-2`}
                value={owner}
                onChange={(event) => setOwner(event.target.value)}
              >
                <option value="">请选择员工</option>
                {query.data?.employees.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <p className="mt-3 text-[12px] text-ql-fg-secondary">
            从保存后的新请求生效，历史归属保留。
          </p>
          {mutation.error ? (
            <p role="alert" className="mt-2 text-ql-danger">
              {mutation.error.message}
            </p>
          ) : null}
          <div className="mt-3 flex justify-end gap-3">
            <button type="button" onClick={onClose}>
              取消
            </button>
            <button
              type="button"
              className="text-ql-action"
              disabled={
                mutation.isPending ||
                (principal.type === "EMPLOYEE"
                  ? !department && !name.trim()
                  : !owner)
              }
              onClick={() => mutation.mutate()}
            >
              保存归属
            </button>
          </div>
        </>
      )}
    </section>
  );
}
