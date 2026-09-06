import { useId, useState } from "react";
import { Search } from "lucide-react";

export const usageInputClass =
  "h-9 min-w-0 w-full rounded-lg border border-ql-border bg-ql-surface px-3 text-[13px] text-ql-fg outline-none focus:border-ql-action focus:ring-1 focus:ring-ql-action";

export function UsageSearchField({
  value,
  onChange,
  onSearch,
  label,
  placeholder,
  pending = false,
}: {
  value: string;
  onChange: (value: string) => void;
  onSearch: () => void;
  label: string;
  placeholder: string;
  pending?: boolean;
}) {
  const inputId = useId();
  return (
    <form
      className="min-w-0"
      onSubmit={(event) => {
        event.preventDefault();
        onSearch();
      }}
      role="search"
    >
      <label
        className="mb-1 block text-[12px] text-ql-fg-secondary"
        htmlFor={inputId}
      >
        用量搜索
      </label>
      <div className="flex gap-2">
        <span className="relative min-w-0 flex-1">
          <Search
            aria-hidden
            className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-ql-fg-tertiary"
          />
          <input
            id={inputId}
            aria-label={label}
            onKeyDown={(event) => {
              if (event.key === "Enter" && event.nativeEvent.isComposing)
                event.preventDefault();
            }}
            className={`${usageInputClass} pl-9`}
            onChange={(event) => onChange(event.target.value)}
            placeholder={placeholder}
            type="search"
            value={value}
          />
        </span>
        <button
          className="h-9 shrink-0 rounded-lg bg-ql-action px-3 text-[13px] font-medium text-white hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ql-action disabled:opacity-50"
          disabled={pending}
          type="submit"
        >
          {pending ? "查询中…" : "查询"}
        </button>
      </div>
    </form>
  );
}

export function UsageKeywordSearch({
  initialValue,
  onSearch,
}: {
  initialValue: string;
  onSearch: (value: string) => void;
}) {
  const [value, setValue] = useState(initialValue);
  return (
    <UsageSearchField
      label="搜索主体、姓名或项目"
      onChange={setValue}
      onSearch={() => onSearch(value.trim())}
      placeholder="主体、姓名或项目"
      value={value}
    />
  );
}
