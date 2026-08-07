const WEEKDAY_OPTIONS = [
  { day: 1, label: "一" },
  { day: 2, label: "二" },
  { day: 3, label: "三" },
  { day: 4, label: "四" },
  { day: 5, label: "五" },
  { day: 6, label: "六" },
  { day: 7, label: "日" },
] as const;

const WEEKDAY_LABELS = ["一", "二", "三", "四", "五", "六", "日"];

/** 把逗号分隔的星期字符串解析为已选数字集合（ISO 1=周一..7=周日）。 */
export function parseDaysOfWeek(value: string | null | undefined): number[] {
  if (!value) return [];
  const parsed = value
    .split(",")
    .map((item) => Number(item.trim()))
    .filter((day) => Number.isInteger(day) && day >= 1 && day <= 7);
  return Array.from(new Set(parsed)).sort((a, b) => a - b);
}

/**
 * 把星期数组格式化为展示文本：
 * - 空/null → "每天"
 * - [1,2,3,4,5] → "工作日"
 * - [6,7] → "周末"
 * - 其它 → "一二三..." 按数字拼接
 */
export function formatDaysOfWeek(days: number[] | null | undefined): string {
  if (!days || days.length === 0) return "每天";
  const sorted = [...days].sort((a, b) => a - b);
  const key = sorted.join(",");
  if (key === "1,2,3,4,5") return "工作日";
  if (key === "6,7") return "周末";
  if (key === "1,2,3,4,5,6,7") return "每天";
  return sorted.map((day) => WEEKDAY_LABELS[day - 1] ?? String(day)).join("");
}

interface Props {
  /** 逗号分隔的星期字符串，如 "1,2,3,4,5"；与现有 zod schema 契约一致。 */
  value: string;
  onChange: (next: string) => void;
  disabled?: boolean;
}

/**
 * 星期多选按钮组。对外保持字符串契约（"1,2,3,4,5"），
 * 可直接接入 react-hook-form 的 watch/setValue，无需改动 schema 与 payload。
 */
export function WeekdayPicker(props: Props) {
  const selected = parseDaysOfWeek(props.value);

  const toggle = (day: number) => {
    const next = selected.includes(day)
      ? selected.filter((item) => item !== day)
      : [...selected, day];
    onChangeEmit(next);
  };

  const onChangeEmit = (days: number[]) => {
    const sorted = [...new Set(days)].sort((a, b) => a - b);
    props.onChange(sorted.join(","));
  };

  return (
    <div className="flex flex-wrap gap-1.5" role="group" aria-label="星期">
      {WEEKDAY_OPTIONS.map((option) => {
        const active = selected.includes(option.day);
        return (
          <button
            key={option.day}
            type="button"
            disabled={props.disabled}
            aria-pressed={active}
            onClick={() => toggle(option.day)}
            className={[
              "h-10 w-10 rounded-lg border text-[14px] transition-colors",
              "focus:outline focus:outline-2 focus:outline-offset-1 focus:outline-ql-action",
              "disabled:cursor-not-allowed disabled:opacity-50",
              active
                ? "border-ql-action bg-ql-surface-brand-soft text-ql-action"
                : "border-ql-border bg-ql-surface text-ql-fg-secondary hover:bg-ql-surface-subtle",
            ].join(" ")}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
