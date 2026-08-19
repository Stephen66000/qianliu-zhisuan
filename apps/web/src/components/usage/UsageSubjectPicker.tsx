import { useDeferredValue, useEffect, useState } from "react";

import { usePrincipalOption, usePrincipalOptions } from "../../api/v2-hooks";

const PAGE_SIZE = 20;

export function UsageSubjectPicker({
  subjectType,
  value,
  onChange,
  selectLabel = "指定用量主体",
  searchLabel = "搜索用量主体",
}: {
  subjectType: "EMPLOYEE" | "PROJECT";
  value: string;
  onChange: (value: string) => void;
  selectLabel?: string;
  searchLabel?: string;
}) {
  const [search, setSearch] = useState("");
  const [offset, setOffset] = useState(0);
  const deferredSearch = useDeferredValue(search.trim());
  const optionsQuery = usePrincipalOptions(subjectType, deferredSearch, offset, PAGE_SIZE);
  const selectedQuery = usePrincipalOption(value || null);

  useEffect(() => setOffset(0), [subjectType, deferredSearch]);

  const items = optionsQuery.data?.principals ?? [];
  const selected = selectedQuery.data?.principal;
  const choices = selected && !items.some((item) => item.id === selected.id)
    ? [selected, ...items]
    : items;
  const total = optionsQuery.data?.total ?? 0;
  const label = subjectType === "EMPLOYEE" ? "员工" : "项目";

  return (
    <div className="flex min-w-64 flex-wrap items-center gap-2">
      <input
        aria-label={searchLabel}
        className="ql-input min-w-40 flex-1"
        onChange={(event) => setSearch(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Enter") return;
          const normalized = search.trim().toLocaleLowerCase("zh-CN");
          const exact = items.filter((item) => item.name.trim().toLocaleLowerCase("zh-CN") === normalized);
          if (exact.length === 1) {
            event.preventDefault();
            onChange(exact[0]!.id);
          }
        }}
        placeholder={`搜索${label}或部门`}
        type="search"
        value={search}
      />
      <select
        aria-label={selectLabel}
        className="ql-input min-w-48 flex-1"
        disabled={optionsQuery.isLoading && choices.length === 0}
        onChange={(event) => onChange(event.target.value)}
        value={value}
      >
        <option value="">全部{label}</option>
        {value && !choices.some((item) => item.id === value) ? <option value={value}>已选{label}</option> : null}
        {choices.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
      </select>
      <span className="whitespace-nowrap text-[11px] text-ql-fg-tertiary">
        {optionsQuery.error ? "主体列表加载失败" : `共 ${total} 个`}
      </span>
      <button
        aria-label="主体上一页"
        className="h-8 rounded-lg border border-ql-border bg-ql-surface px-2 text-[12px] disabled:cursor-not-allowed disabled:opacity-50"
        disabled={offset === 0}
        onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
        type="button"
      >上一页</button>
      <button
        aria-label="主体下一页"
        className="h-8 rounded-lg border border-ql-border bg-ql-surface px-2 text-[12px] disabled:cursor-not-allowed disabled:opacity-50"
        disabled={offset + PAGE_SIZE >= total}
        onClick={() => setOffset(offset + PAGE_SIZE)}
        type="button"
      >下一页</button>
    </div>
  );
}
