import { employeeQuotaMonth } from "@qianliu/domain";

export function completedReportMonth(month?: string, now = new Date(), timezone = "Asia/Shanghai") {
  const local = new Intl.DateTimeFormat("sv-SE", { timeZone: timezone, year: "numeric", month: "2-digit" }).format(now);
  const [currentYear, currentMonth] = local.split("-").map(Number);
  const selected = month ?? (currentMonth === 1 ? `${currentYear! - 1}-12`
    : `${currentYear}-${String(currentMonth! - 1).padStart(2, "0")}`);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(selected)) throw new Error("月报月份必须为 YYYY-MM");
  const [year, number] = selected.split("-").map(Number);
  const localMonth = employeeQuotaMonth(new Date(`${selected}-15T12:00:00Z`), timezone);
  const start = localMonth.periodStart;
  const end = localMonth.periodEnd;
  if (!Number.isFinite(start.getTime()) || end > now) throw new Error("月报只能统计已经结束的完整自然月");
  const days = new Date(Date.UTC(year!, number!, 0)).getUTCDate();
  return { month: selected, start, end, days, anchor: new Date(end.getTime() - 1),
    label: `${year} 年 ${number} 月`, dateRange: `${year} 年 ${number} 月 · ${number}.1 - ${number}.${days}` };
}

export function monthlyReportDue(now: Date): boolean {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Shanghai", day: "numeric", hour: "numeric", minute: "numeric", hourCycle: "h23" }).formatToParts(now);
  const value = (type: string) => Number(parts.find(part => part.type === type)?.value);
  return value("day") === 1 && value("hour") === 9 && value("minute") < 30;
}
