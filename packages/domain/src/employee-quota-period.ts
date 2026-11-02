/** Enterprise-local calendar months. No server-local Date methods or fixed month lengths. */
export function employeeQuotaMonth(
  now: Date,
  timezone: string,
): {
  periodKey: string;
  periodStart: Date;
  periodEnd: Date;
  timezone: string;
} {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const parts = (date: Date) =>
    Object.fromEntries(
      formatter
        .formatToParts(date)
        .filter((p) => p.type !== "literal")
        .map((p) => [p.type, Number(p.value)]),
    );
  const local = parts(now);
  const midnight = (year: number, month: number) => {
    const target = Date.UTC(year, month - 1, 1);
    let instant = target;
    for (let i = 0; i < 4; i++) {
      const p = parts(new Date(instant));
      const delta =
        target -
        Date.UTC(p.year!, p.month! - 1, p.day!, p.hour!, p.minute!, p.second!);
      if (delta === 0) return new Date(instant);
      instant += delta;
    }
    throw new Error("quota_month_boundary_unresolvable");
  };
  const year = local.year!;
  const month = local.month!;
  return {
    periodKey: `${year}-${String(month).padStart(2, "0")}`,
    periodStart: midnight(year, month),
    periodEnd: midnight(
      month === 12 ? year + 1 : year,
      month === 12 ? 1 : month + 1,
    ),
    timezone,
  };
}

export function employeeQuotaBalance(
  limit: bigint,
  used: bigint,
  reserved: bigint,
) {
  if (limit < 0n || used < 0n || reserved < 0n)
    throw new Error("negative_quota_fact");
  const available = limit - used - reserved;
  return {
    available: available > 0n ? available : 0n,
    overage: used > limit ? used - limit : 0n,
  };
}
