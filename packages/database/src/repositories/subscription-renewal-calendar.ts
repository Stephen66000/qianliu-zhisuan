const DAY = 86_400_000;
const OFFSET = 8 * 3_600_000;
function dateParts(value: Date) {
  const local = new Date(value.getTime() + OFFSET);
  return { year: local.getUTCFullYear(), month: local.getUTCMonth(), day: local.getUTCDate() };
}
function addMonths(value: Date, months: number, anchorDay: number) {
  const local = dateParts(value);
  const target = new Date(Date.UTC(local.year, local.month + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  return new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), Math.min(anchorDay, lastDay)) - OFFSET);
}

/** Keep the original calendar anchor through short months; otherwise repeat the explicitly registered day interval. */
export function nextSubscriptionEnd(templateStart: Date, templateEnd: Date, nextStart: Date): Date {
  const start = dateParts(templateStart), end = dateParts(templateEnd);
  const duration = templateEnd.getTime() - templateStart.getTime();
  if (!Number.isFinite(duration) || duration <= 0 || duration % DAY !== 0) throw new Error("Invalid subscription period");
  const months = (end.year - start.year) * 12 + end.month - start.month;
  if (months > 0 && addMonths(templateStart, months, start.day).getTime() === templateEnd.getTime()) {
    return addMonths(nextStart, months, start.day);
  }
  return new Date(nextStart.getTime() + duration);
}
