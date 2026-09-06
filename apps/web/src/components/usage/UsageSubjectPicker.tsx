import { useDeferredValue, useEffect, useRef, useState } from "react";

import {
  resolvePrincipalExactMatch,
  usePrincipalOption,
  usePrincipalOptions,
} from "../../api/v2-hooks";

import { UsageSearchField, usageInputClass } from "./UsageSearchField";

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
  const [pending, setPending] = useState(false);
  const [exactError, setExactError] = useState<string | null>(null);
  const deferredSearch = useDeferredValue(search.trim());
  const exactRequestGeneration = useRef(0);
  const latestContext = useRef({ subjectType, search });
  latestContext.current = { subjectType, search };
  const optionsQuery = usePrincipalOptions(
    subjectType,
    deferredSearch,
    offset,
    PAGE_SIZE,
  );
  const selectedQuery = usePrincipalOption(value || null);

  useEffect(() => setOffset(0), [subjectType, deferredSearch]);
  useEffect(() => {
    exactRequestGeneration.current += 1;
    setExactError(null);
    setPending(false);
    setSearch("");
  }, [subjectType]);
  useEffect(
    () => () => {
      exactRequestGeneration.current += 1;
    },
    [],
  );

  const items = optionsQuery.data?.principals ?? [];
  const selected = selectedQuery.data?.principal;
  const choices =
    selected && !items.some((item) => item.id === selected.id)
      ? [selected, ...items]
      : items;
  const total = optionsQuery.data?.total ?? 0;
  const label = subjectType === "EMPLOYEE" ? "员工" : "项目";

  const searchSubject = () => {
    const name = search.trim();
    if (!name) {
      exactRequestGeneration.current += 1;
      setExactError(null);
      setPending(false);
      onChange("");
      return;
    }
    const requestedType = subjectType;
    const requestedSearch = search;
    const generation = ++exactRequestGeneration.current;
    const isCurrent = () =>
      generation === exactRequestGeneration.current &&
      latestContext.current.subjectType === requestedType &&
      latestContext.current.search === requestedSearch;
    setPending(true);
    setExactError(null);
    void resolvePrincipalExactMatch(subjectType, name)
      .then((result) => {
        if (!isCurrent()) return;
        if (result.match_count === 1 && result.principal)
          onChange(result.principal.id);
        else
          setExactError(
            result.match_count > 1
              ? "找到同名主体，请从匹配主体中选择"
              : "没有完全匹配的主体，请从匹配主体中选择或调整关键词",
          );
      })
      .catch(() => {
        if (isCurrent()) setExactError("精确匹配失败，请稍后重试或从列表选择");
      })
      .finally(() => {
        if (isCurrent()) setPending(false);
      });
  };

  return (
    <div className="grid min-w-0 flex-1 gap-3 sm:grid-cols-2">
      <UsageSearchField
        label={searchLabel}
        onChange={(next) => {
          exactRequestGeneration.current += 1;
          setExactError(null);
          setPending(false);
          setOffset(0);
          setSearch(next);
        }}
        onSearch={searchSubject}
        pending={pending}
        placeholder={`搜索${label}或部门`}
        value={search}
      />
      <div className="min-w-0">
        <label className="mb-1 block text-[12px] text-ql-fg-secondary">
          匹配主体
          <select
            aria-label={selectLabel}
            className={`${usageInputClass} mt-1`}
            disabled={optionsQuery.isLoading && choices.length === 0}
            onChange={(event) => {
              exactRequestGeneration.current += 1;
              setPending(false);
              setExactError(null);
              onChange(event.target.value);
            }}
            value={value}
          >
            <option value="">全部{label}</option>
            {value && !choices.some((item) => item.id === value) ? (
              <option value={value}>已选{label}</option>
            ) : null}
            {choices.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
                {item.department_label ? ` · ${item.department_label}` : ""}
              </option>
            ))}
          </select>
        </label>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <span className="whitespace-nowrap text-[11px] text-ql-fg-tertiary">
            {optionsQuery.error ? "主体列表加载失败" : `共 ${total} 个`}
          </span>
          {total > PAGE_SIZE ? (
            <>
              <button
                aria-label="主体上一页"
                className="h-8 rounded-lg border border-ql-border bg-ql-surface px-2 text-[12px] disabled:cursor-not-allowed disabled:opacity-50"
                disabled={offset === 0}
                onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
                type="button"
              >
                上一页
              </button>
              <button
                aria-label="主体下一页"
                className="h-8 rounded-lg border border-ql-border bg-ql-surface px-2 text-[12px] disabled:cursor-not-allowed disabled:opacity-50"
                disabled={offset + PAGE_SIZE >= total}
                onClick={() => setOffset(offset + PAGE_SIZE)}
                type="button"
              >
                下一页
              </button>
            </>
          ) : null}
        </div>
      </div>
      {exactError ? (
        <p
          aria-live="polite"
          className="text-[12px] text-ql-warning sm:col-span-2"
          role="status"
        >
          {exactError}
        </p>
      ) : null}
    </div>
  );
}
