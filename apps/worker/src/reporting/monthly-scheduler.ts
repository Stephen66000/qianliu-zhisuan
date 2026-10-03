import { randomUUID } from "node:crypto";
import type { createClient } from "redis";
import { completedReportMonth, monthlyReportDue } from "./monthly-period.js";
import { runCompanyMonthlyReport, runPersonalMonthlyReports, type CompanyMonthlyReportOptions } from "./monthly-reports.js";

export interface MonthlyReportStore {
  has(key: string): Promise<boolean>;
  mark(key: string): Promise<void>;
  acquire(key: string, token: string): Promise<boolean>;
  release(key: string, token: string): Promise<void>;
}
export class RedisMonthlyReportStore implements MonthlyReportStore {
  constructor(private redis: Pick<ReturnType<typeof createClient>, "get" | "set" | "eval">) {}
  async has(key: string) { return Boolean(await this.redis.get(key)); }
  async mark(key: string) { await this.redis.set(key, "1", { EX: 90 * 86400 }); }
  async acquire(key: string, token: string) { return await this.redis.set(key, token, { NX: true, EX: 1800 }) === "OK"; }
  async release(key: string, token: string) {
    await this.redis.eval("if redis.call('get',KEYS[1])==ARGV[1] then return redis.call('del',KEYS[1]) else return 0 end", { keys: [key], arguments: [token] });
  }
}

/** Month and recipient receipts survive restarts; no late catch-up outside the agreed window. */
export async function runMonthlyReportTick(input: Omit<CompanyMonthlyReportOptions, "month" | "recipients" | "dryRun"> & {
  now: Date;
  store: MonthlyReportStore | null;
  company?: typeof runCompanyMonthlyReport;
  personal?: typeof runPersonalMonthlyReports;
}): Promise<{ status: string; complete: boolean; month?: string }> {
  if (!monthlyReportDue(input.now)) return { status: "OUTSIDE_WINDOW", complete: false };
  if (!input.store) return { status: "NO_DURABLE_STORE", complete: false };
  const month = completedReportMonth(undefined, input.now).month;
  const key = `scheduler:monthly_report:${input.enterpriseId}:${month}`;
  if (await input.store.has(`${key}:complete`)) return { status: "ALREADY_SENT", complete: true, month };
  const token = randomUUID();
  if (!await input.store.acquire(`${key}:lock`, token)) return { status: "BUSY", complete: false, month };
  try {
    const options = { db: input.db, kekBase64: input.kekBase64, enterpriseId: input.enterpriseId, month };
    if (!await input.store.has(`${key}:company`)) {
      const company = await (input.company ?? runCompanyMonthlyReport)(options);
      if (company.status !== "SENT") return { status: company.status, complete: false, month };
      await input.store.mark(`${key}:company`);
    }
    const store = input.store;
    const personal = await (input.personal ?? runPersonalMonthlyReports)({ ...options,
      shouldSend: async principalId => !await store.has(`${key}:personal:${principalId}`),
      onSent: principalId => store.mark(`${key}:personal:${principalId}`),
    });
    const complete = personal.every(result => result.status === "SENT");
    if (complete) await input.store.mark(`${key}:complete`);
    return { status: complete ? "SENT" : "RECIPIENTS_PENDING", complete, month };
  } finally { await input.store.release(`${key}:lock`, token); }
}
