import { sql, type Kysely } from "kysely";
import { ReportDeliveryRepository, type Database, type ReportBundle, type ReportType, type ReportMessage } from "@qianliu/database";
import { executeReportBundle, reportWindow, summarizeMessages } from "./delivery.js";
import { runDailyTokenReport } from "./daily-token-report.js";
import { runCompanyWeeklyReport, runPersonalWeeklyReports } from "./report-jobs.js";
import { runCompanyMonthlyReport, runPersonalMonthlyReports } from "./monthly-reports.js";
import { checkAndDispatchTop1Milestone, checkAndDispatchOver50Milestone, type IncentiveCheckOptions } from "./incentive-jobs.js";
import { completedReportMonth } from "./monthly-period.js";

export function dueReportTypes(now: Date): ReportType[] {
  const local = new Date(now.getTime()+8*3600_000), day = local.getUTCDay();
  if (local.getUTCHours() !== 9) return [];
  if (local.getUTCMinutes() >= 30) return day === 0 || day >= 3 ? ["TOP1", "OVER50"] : [];
  return ["DAILY", ...(day === 1 ? ["COMPANY_WEEKLY", "PERSONAL_WEEKLY"] as const : []),
    ...(local.getUTCDate() === 1 ? ["COMPANY_MONTHLY", "PERSONAL_MONTHLY"] as const : [])];
}
export function reportScheduleActive(now: Date, enabledAt?: string, paused?: string) {
  const start = enabledAt ? new Date(enabledAt) : null;
  return paused !== "1" && start !== null && Number.isFinite(start.getTime()) && now >= start;
}

export async function runReportDeliveryTick(input: {
  db: Kysely<Database>; kekBase64: string; now: Date; enabledAt?: string; paused?: string;
  legacyGet: (key: string) => Promise<string | null>;
  milestoneStore?: IncentiveCheckOptions["milestoneStore"];
}) {
  const { db, now } = input;
  if (!reportScheduleActive(now, input.enabledAt, input.paused)) return { status: "DISABLED" };
  const date = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  const repo = new ReportDeliveryRepository(db);
  const enterprises = await db.selectFrom("enterprise").select("id").where("status", "=", "ACTIVE").execute();
  const results: Array<{ enterprise: string; type: ReportType; status: string }> = [];
  for (const { id: enterpriseId } of enterprises) {
    await repo.expire(enterpriseId, now);
    for (const type of dueReportTypes(now)) {
      const window = reportWindow(now, type === "TOP1" || type === "OVER50");
      if (window.start < new Date(input.enabledAt!)) continue; // Never enter an already-open historical window.
      try {
        const status = await db.transaction().execute(async tx => {
          const lock = await sql<{ acquired: boolean }>`SELECT pg_try_advisory_xact_lock(hashtextextended(${enterpriseId+type+date},1)) AS acquired`.execute(tx);
          if (!lock.rows[0]?.acquired) return "BUSY";
          const run = (await sql<{ status: string }>`SELECT status FROM report_delivery_schedule WHERE enterprise_id=${enterpriseId}
            AND report_type=${type} AND schedule_date=${date}`.execute(tx)).rows[0];
          if (run?.status === "LEGACY_UNVERIFIED") return run.status;
          // Fresh deployment reads legacy flags before discovery. Redis failure fails closed.
          if (!run) {
            const legacyKey = legacyScheduleKey(type, enterpriseId, date, now);
            if (await input.legacyGet(legacyKey)) {
              await saveSchedule(tx, enterpriseId, type, date, "LEGACY_UNVERIFIED");
              return "LEGACY_UNVERIFIED";
            }
          }
          const existing = (await sql<ReportBundle>`SELECT * FROM report_delivery_bundle WHERE enterprise_id=${enterpriseId}
            AND report_type=${type} AND window_start=${window.start} AND window_end=${window.end} ORDER BY created_at,recipient_ref`.execute(tx)).rows;
          for (const bundle of existing) {
            const delivery = await executeReportBundle({ repo, bundle, kekBase64: input.kekBase64 });
            if (delivery.status === "SENT" && input.milestoneStore) {
              if (bundle.report_type === "TOP1") {
                await input.milestoneStore.recordTop1IssuedToday(enterpriseId,date);
                await input.milestoneStore.recordUserAwardedTop1ThisWeek(enterpriseId,bundle.period_key,bundle.recipient_ref);
              }
              if (bundle.report_type === "OVER50") await input.milestoneStore.recordUserAwardedOver50ThisMonth(enterpriseId,bundle.period_key,bundle.recipient_ref);
            }
          }
          if (run?.status === "DISCOVERED") return "RESUMED";
          // An aggregation failure does not prevent this stage from running. Dirty or unavailable
          // reporting facts explicitly block new content; existing frozen deliveries may resume.
          const dirty = await db.selectFrom("usage_aggregate_dirty_bucket").select("enterprise_id")
            .where("enterprise_id", "=", enterpriseId).limit(1).executeTakeFirst();
          if (dirty) {
            await saveSchedule(tx, enterpriseId, type, date, "BLOCKED", "REPORT_DATA_DIRTY");
            return "BLOCKED";
          }
          const options = { db, kekBase64: input.kekBase64, enterpriseId, now, deliveryWindow: window,
            milestoneStore: input.milestoneStore };
          const result = await discover(type, { ...options,
            ...(type === "PERSONAL_MONTHLY" ? { shouldSend: async (principalId: string) => !await input.legacyGet(
              `scheduler:monthly_report:${enterpriseId}:${completedReportMonth(undefined, now).month}:personal:${principalId}`) } : {}),
          });
          const failed = JSON.stringify(result).includes('"DELIVERY_FAILED"');
          await saveSchedule(tx, enterpriseId, type, date, failed ? "BLOCKED" : "DISCOVERED", failed ? "RECIPIENT_FAILURE" : Array.isArray(result) && result.length === 0 ? "NO_ELIGIBLE_RECIPIENTS"
            : typeof result === "object" && result && "status" in result && result.status === "NO_ELIGIBLE_RECIPIENTS" ? "NO_ELIGIBLE_RECIPIENTS" : undefined);
          return failed ? "RECIPIENT_FAILURE" : "DISCOVERED";
        });
        results.push({ enterprise: enterpriseId, type, status });
      } catch (error) {
        // Keep reason fixed and sanitized; a failed tenant/type never prevents the next one.
        await saveSchedule(db, enterpriseId, type, date, "BLOCKED", "REPORT_TASK_FAILED");
        console.error(JSON.stringify({ event: "report_delivery_task_failed", enterprise_id: enterpriseId,
          report_type: type, error_type: error instanceof Error ? error.name : typeof error }));
        results.push({ enterprise: enterpriseId, type, status: "BLOCKED" });
      }
    }
  }
  const summaries = [];
  const grouped = new Map<string, ReportMessage[]>();
  for (const { id: enterpriseId } of enterprises) {
    const bundles = (await sql<ReportBundle>`SELECT * FROM report_delivery_bundle WHERE enterprise_id=${enterpriseId}
      AND window_start>=${new Date(`${date}T00:00:00+08:00`)} AND window_start<${new Date(`${date}T23:59:59.999+08:00`)}`.execute(db)).rows;
    for (const bundle of bundles) {
      const messages=await repo.messages(enterpriseId,bundle.id), key=`${enterpriseId}:${bundle.report_type}`;
      grouped.set(key,[...(grouped.get(key) ?? []),...messages]);
      summaries.push({ enterprise: enterpriseId, type: bundle.report_type, period: bundle.period_key,
        recipient: bundle.recipient_ref, ...summarizeMessages(messages) });
    }
  }
  const tasks=results.map(result=>{
    const summary=summarizeMessages(grouped.get(`${result.enterprise}:${result.type}`) ?? []);
    const status=["LEGACY_UNVERIFIED","BLOCKED","RECIPIENT_FAILURE","BUSY"].includes(result.status) ? result.status : summary.status;
    return { ...result, ...summary, status };
  });
  return { status: "PROCESSED", results, tasks, summaries };
}
function legacyScheduleKey(type: ReportType, enterprise: string, date: string, now: Date) {
  if (type.includes("MONTHLY")) {
    const month = completedReportMonth(undefined, now).month;
    return `scheduler:monthly_report:${enterprise}:${month}:${type === "COMPANY_MONTHLY" ? "company" : "complete"}`;
  }
  const kind = type === "DAILY" ? "daily_report" : type.includes("WEEKLY") ? "weekly_report" : "incentive_check";
  return `scheduler:${kind}:${enterprise}:${date}`;
}
async function saveSchedule(db: Kysely<Database>, enterprise: string, type: ReportType, date: string, status: string, classification?: string) {
  await sql`INSERT INTO report_delivery_schedule(enterprise_id,report_type,schedule_date,status,classification)
    VALUES(${enterprise},${type},${date},${status},${classification ?? null}) ON CONFLICT(enterprise_id,report_type,schedule_date)
    DO UPDATE SET status=excluded.status,classification=excluded.classification,updated_at=now()`.execute(db);
}
async function discover(type: ReportType, options: IncentiveCheckOptions & { shouldSend?: (principalId: string) => Promise<boolean> }) {
  switch (type) {
    case "DAILY": return runDailyTokenReport(options);
    case "COMPANY_WEEKLY": return runCompanyWeeklyReport(options);
    case "PERSONAL_WEEKLY": return runPersonalWeeklyReports(options);
    case "COMPANY_MONTHLY": return runCompanyMonthlyReport({ ...options, month: completedReportMonth(undefined, options.now).month });
    case "PERSONAL_MONTHLY": return runPersonalMonthlyReports({ ...options, month: completedReportMonth(undefined, options.now).month });
    case "TOP1": return checkAndDispatchTop1Milestone(options);
    case "OVER50": return checkAndDispatchOver50Milestone(options);
  }
}
