import { completedReportMonth } from "./monthly-period.js";
import { runCompanyWeeklyReport, runPersonalWeeklyReports,
  type RunCompanyWeeklyReportOptions, type RunPersonalWeeklyReportsOptions } from "./report-jobs.js";

export type CompanyMonthlyReportOptions = Omit<RunCompanyWeeklyReportOptions, "targetDate" | "reportMonth"> & { month?: string };
export type PersonalMonthlyReportOptions = Omit<RunPersonalWeeklyReportsOptions, "targetDate" | "reportMonth"> & { month?: string };

export async function runCompanyMonthlyReport(options: CompanyMonthlyReportOptions) {
  return runCompanyWeeklyReport({ ...options, reportMonth: await reportMonthForEnterprise(options) });
}
export async function runPersonalMonthlyReports(options: PersonalMonthlyReportOptions) {
  return runPersonalWeeklyReports({ ...options, reportMonth: await reportMonthForEnterprise(options) });
}

async function reportMonthForEnterprise(options: CompanyMonthlyReportOptions | PersonalMonthlyReportOptions) {
  const enterprise = await options.db.selectFrom("enterprise").select("timezone").where("id", "=", options.enterpriseId).executeTakeFirstOrThrow();
  return completedReportMonth(options.month, options.now ?? options.clock?.(), enterprise.timezone || "Asia/Shanghai").month;
}
