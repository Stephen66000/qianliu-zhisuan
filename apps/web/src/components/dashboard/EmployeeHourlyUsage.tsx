import { formatCount } from "../../lib/format";

interface HourlyUsageItem {
  hour: number;
  totalTokens: string;
  collectionStatus: "COMPLETE" | "MISSING";
}

export function EmployeeHourlyUsage({ items }: { items: HourlyUsageItem[] }) {
  const maximum = items.reduce((current, item) => {
    if (item.collectionStatus !== "COMPLETE") return current;
    const value = BigInt(item.totalTokens);
    return value > current ? value : current;
  }, 0n);

  return (
    <div className="overflow-x-auto rounded-xl border border-ql-border bg-ql-surface-subtle p-4">
      <div className="flex min-w-max items-end gap-3">
        {items.map((item) => {
          const value = BigInt(item.totalTokens);
          const hasUsage = item.collectionStatus === "COMPLETE" && value > 0n;
          const height = hasUsage && maximum > 0n
            ? Math.max(6, Number(value * 100n / maximum))
            : 0;
          const hourLabel = `${String(item.hour).padStart(2, "0")}:00`;
          const valueLabel = item.collectionStatus === "MISSING"
            ? "未采集"
            : formatCount(item.totalTokens);
          return (
            <div
              aria-label={`${hourLabel} ${item.collectionStatus === "MISSING" ? "未采集" : `消耗 ${valueLabel}`}`}
              className="flex w-12 shrink-0 flex-col items-center"
              key={item.hour}
            >
              <span className="mb-2 h-4 text-[10px] text-ql-fg-secondary">{valueLabel}</span>
              <div className="flex h-24 w-full items-end justify-center">
                {hasUsage ? (
                  <div
                    className="w-5 rounded-t bg-ql-action"
                    data-hourly-bar
                    style={{ height: `${height}%` }}
                  />
                ) : null}
              </div>
              <span className="mt-2 text-[10px] text-ql-fg-tertiary">{hourLabel}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
