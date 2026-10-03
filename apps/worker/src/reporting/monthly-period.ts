import type { Kysely } from "kysely";
import type { Database } from "@qianliu/database";

export function completedReportMonth(month?: string, now = new Date()) {
  const local = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit" }).format(now);
  const [currentYear, currentMonth] = local.split("-").map(Number);
  const selected = month ?? (currentMonth === 1 ? `${currentYear! - 1}-12`
    : `${currentYear}-${String(currentMonth! - 1).padStart(2, "0")}`);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(selected)) throw new Error("月报月份必须为 YYYY-MM");
  const [year, number] = selected.split("-").map(Number);
  const next = number === 12 ? `${year! + 1}-01` : `${year}-${String(number! + 1).padStart(2, "0")}`;
  const start = new Date(`${selected}-01T00:00:00+08:00`);
  const end = new Date(`${next}-01T00:00:00+08:00`);
  if (!Number.isFinite(start.getTime()) || end > now) throw new Error("月报只能统计已经结束的完整自然月");
  const days = Math.round((end.getTime() - start.getTime()) / 86_400_000);
  return { month: selected, start, end, days, anchor: new Date(end.getTime() - 1),
    label: `${year} 年 ${number} 月`, dateRange: `${year} 年 ${number} 月 · ${number}.1 - ${number}.${days}` };
}

/** Historical month-end allocation, never the new month's mutable quota counter.
 * Later grant edits have no retained historical value and are displayed as missing. */
export async function queryMonthEndAllocation(db: Kysely<Database>, enterpriseId: string, end: Date, principalId?: string): Promise<number | null> {
  const rows = await db.selectFrom("principal_grant").select(["quota_value", "updated_at", "status", "valid_from", "valid_until"])
    .where("enterprise_id", "=", enterpriseId).where("created_at", "<", end)
    .$if(Boolean(principalId), qb => qb.where("principal_id", "=", principalId!)).execute();
  if (rows.some(row => row.updated_at >= end)) return null;
  return rows.filter(row => row.status === "ACTIVE" && row.valid_from < end && (row.valid_until === null || row.valid_until >= end))
    .reduce((total, row) => total + Number(row.quota_value), 0);
}

export function monthlyReportDue(now: Date): boolean {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Shanghai", day: "numeric", hour: "numeric", minute: "numeric", hourCycle: "h23" }).formatToParts(now);
  const value = (type: string) => Number(parts.find(part => part.type === type)?.value);
  return value("day") === 1 && value("hour") === 9 && value("minute") < 30;
}
