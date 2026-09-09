import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { get, post } from "../../api/client";
import type { Principal } from "../../api/types";
import { useFeatureFlags } from "../../feature-flags";
import { INPUT_CLASS } from "../writes/FormField";

export function PrincipalCreateForm({ onClose }: { onClose: () => void }) {
  const [type, setType] = useState<"EMPLOYEE" | "PROJECT">("EMPLOYEE"),
    [name, setName] = useState(""),
    [department, setDepartment] = useState(""),
    [owner, setOwner] = useState("");
  const strict = useFeatureFlags().FEATURE_DEPARTMENT_COST;
  const [validation, setValidation] = useState("");
  const client = useQueryClient();
  const people = useQuery({
    queryKey: ["principals", "owner-options"],
    queryFn: ({ signal }) =>
      get<{ principals: Principal[] }>(
        "/principals?type=EMPLOYEE&archived=exclude",
        signal,
      ),
    enabled: type === "PROJECT",
  });
  const create = useMutation({
    mutationFn: () =>
      post("/principals", {
        type,
        name: name.trim(),
        accounting_required: strict,
        ...(type === "EMPLOYEE"
          ? { department_label: department.trim() }
          : owner
            ? { owner_principal_id: owner }
            : {}),
      }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["principals"] });
      void client.invalidateQueries({
        predicate: (q) =>
          String(q.queryKey[0]).startsWith("principal") ||
          String(q.queryKey[0]).startsWith("operating"),
      });
      onClose();
    },
  });
  return (
    <form data-write-action
      noValidate
      className="space-y-3 rounded-xl border border-ql-border bg-ql-surface p-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (!name.trim()) {
          setValidation("名称不能为空");
          return;
        }
        if (strict && (type === "EMPLOYEE" ? !department.trim() : !owner)) {
          setValidation(
            type === "EMPLOYEE" ? "员工必须指定部门" : "项目必须指定负责人",
          );
          return;
        }
        setValidation("");
        create.mutate();
      }}
    >
      <h2 className="text-[16px] font-semibold">新建主体</h2>
      <div className="grid gap-3 md:grid-cols-3">
        <label>
          类型
          <select
            id="principal-type"
            className={`${INPUT_CLASS} mt-1 w-full`}
            value={type}
            onChange={(e) => setType(e.target.value as typeof type)}
          >
            <option value="EMPLOYEE">员工</option>
            <option value="PROJECT">项目</option>
          </select>
        </label>
        <label>
          名称
          <input
            id="principal-name"
            className={`${INPUT_CLASS} mt-1 w-full`}
            required
            maxLength={255}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="如：张三 / 数据平台项目组"
          />
        </label>
        {type === "EMPLOYEE" ? (
          <label>
            所属部门
            <input
              className={`${INPUT_CLASS} mt-1 w-full`}
              required
              maxLength={255}
              value={department}
              onChange={(e) => setDepartment(e.target.value)}
              placeholder="如：研发部"
            />
          </label>
        ) : (
          <label>
            项目负责人
            <select
              className={`${INPUT_CLASS} mt-1 w-full`}
              required
              value={owner}
              onChange={(e) => setOwner(e.target.value)}
            >
              <option value="">请选择员工</option>
              {people.data?.principals.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      {validation ? (
        <p role="alert" className="text-ql-danger">
          {validation}
        </p>
      ) : null}
      {(create.error ?? people.error) ? (
        <p role="alert" className="text-ql-danger">
          {(create.error ?? people.error)?.message}
        </p>
      ) : null}
      <div className="flex justify-end gap-3">
        <button type="button" onClick={onClose}>
          取消
        </button>
        <button data-write-action
          type="submit"
          className="text-ql-action"
          disabled={create.isPending}
        >
          创建
        </button>
      </div>
    </form>
  );
}
