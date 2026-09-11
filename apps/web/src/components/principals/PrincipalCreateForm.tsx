import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { get, post } from "../../api/client";
import type { Principal } from "../../api/types";
import type { DirectoryMember } from "../../api/v2-types";
import { useFeatureFlags } from "../../feature-flags";
import { maskMobile } from "../../lib/format";
import { INPUT_CLASS } from "../writes/FormField";

export function PrincipalCreateForm({ onClose }: { onClose: () => void }) {
  const [type, setType] = useState<"EMPLOYEE" | "PROJECT">("EMPLOYEE"),
    [name, setName] = useState(""),
    [department, setDepartment] = useState(""),
    [owner, setOwner] = useState("");
  const strict = useFeatureFlags().FEATURE_DEPARTMENT_COST;
  const [validation, setValidation] = useState("");
  const client = useQueryClient();

  // B 方式：员工主体名称联想企微候选人，点选后绑定 person_id 并带出部门。
  const [personSuggestions, setPersonSuggestions] = useState<DirectoryMember[]>([]);
  const [suggestionsOpen, setSuggestionsOpen] = useState(false);
  const [selectedPerson, setSelectedPerson] = useState<DirectoryMember | null>(null);
  const suggestBoxRef = useRef<HTMLLabelElement | null>(null);

  useEffect(() => {
    if (type !== "EMPLOYEE") return;
    if (selectedPerson && name === selectedPerson.name) return;
    setSelectedPerson(null);
    const keyword = name.trim();
    if (!keyword) {
      setPersonSuggestions([]);
      setSuggestionsOpen(false);
      return;
    }
    const timer = setTimeout(() => {
      void get<{ items?: DirectoryMember[] }>(
        `/directory-members?search=${encodeURIComponent(keyword)}&limit=20`,
      )
        .then((result) => {
          setPersonSuggestions(Array.isArray(result?.items) ? result.items : []);
          setSuggestionsOpen(true);
        })
        .catch(() => {
          setPersonSuggestions([]);
          setSuggestionsOpen(false);
        });
    }, 300);
    return () => clearTimeout(timer);
  }, [type, name, selectedPerson]);

  useEffect(() => {
    const onClickOutside = (event: MouseEvent) => {
      if (suggestBoxRef.current && !suggestBoxRef.current.contains(event.target as Node)) {
        setSuggestionsOpen(false);
      }
    };
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, []);

  const choosePerson = (member: DirectoryMember) => {
    setSelectedPerson(member);
    setName(member.name);
    setDepartment(member.department_name ?? "");
    setSuggestionsOpen(false);
  };

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
        person_id: selectedPerson?.person_id ?? null,
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
        <label className="relative" ref={suggestBoxRef}>
          名称
          <input
            aria-autocomplete="list"
            autoComplete="off"
            id="principal-name"
            className={`${INPUT_CLASS} mt-1 w-full`}
            required
            maxLength={255}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={
              type === "EMPLOYEE"
                ? "如：张三（输入可联想企微候选人）"
                : "如：数据平台项目组"
            }
          />
          {type === "EMPLOYEE" && suggestionsOpen && personSuggestions.length > 0 ? (
            <ul
              aria-label="企微候选人"
              className="absolute z-20 mt-1 max-h-60 w-full overflow-y-auto rounded-lg border border-ql-border bg-ql-surface-raised py-1 shadow-ql-raised"
              role="listbox"
            >
              {personSuggestions.map((member) => (
                <li
                  key={member.person_id}
                  role="option"
                  aria-selected={selectedPerson?.person_id === member.person_id}
                >
                  <button
                    className="w-full px-3 py-2 text-left hover:bg-ql-surface-subtle"
                    onClick={() => choosePerson(member)}
                    type="button"
                  >
                    <span className="block text-[13px] font-medium text-ql-fg">
                      {member.name}
                      {member.employee_number ? ` · 工号: ${member.employee_number}` : ""}
                    </span>
                    <span className="block text-[12px] text-ql-fg-tertiary">
                      {member.department_name ?? "待归属"}
                      {member.external_member_id
                        ? ` · 企微账号: ${member.external_member_id}`
                        : ""}
                      {member.mobile ? ` · 手机: ${maskMobile(member.mobile)}` : ""}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
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
      {type === "EMPLOYEE" && selectedPerson ? (
        <p className="text-[12px] text-ql-fg-secondary" role="status">
          已绑定企微候选人「{selectedPerson.name}」
          {selectedPerson.external_member_id ? `（企微ID: ${selectedPerson.external_member_id}）` : ""}
          {selectedPerson.employee_number ? `（工号: ${selectedPerson.employee_number}）` : ""}
          {selectedPerson.mobile ? `（手机: ${maskMobile(selectedPerson.mobile)}）` : ""}；
          手动修改名称将解除绑定。
        </p>
      ) : null}
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
