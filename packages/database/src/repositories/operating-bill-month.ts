/** 账期参数只接受 YYYY-MM，边界固定为北京时间自然月。 */
export function operatingBillMonthRange(month: string): { start: Date; end: Date; monthDate: string } {
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(month);
  if (!match) throw new InvalidOperatingBillMonthError();
  const year = Number(match[1]);
  const monthNumber = Number(match[2]);
  if (year < 2000 || year > 2200) throw new InvalidOperatingBillMonthError();
  const nextYear = monthNumber === 12 ? year + 1 : year;
  const nextMonth = monthNumber === 12 ? 1 : monthNumber + 1;
  return {
    start: new Date(`${month}-01T00:00:00+08:00`),
    end: new Date(`${nextYear}-${String(nextMonth).padStart(2, "0")}-01T00:00:00+08:00`),
    monthDate: `${month}-01`,
  };
}

export class InvalidOperatingBillMonthError extends Error {}
