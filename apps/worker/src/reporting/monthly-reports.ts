import { completedReportMonth } from "./monthly-period.js";
import { runCompanyWeeklyReport, runPersonalWeeklyReports,
  type RunCompanyWeeklyReportOptions, type RunPersonalWeeklyReportsOptions } from "./report-jobs.js";

export type CompanyMonthlyReportOptions = Omit<RunCompanyWeeklyReportOptions, "targetDate" | "reportMonth"> & { month?: string };
export type PersonalMonthlyReportOptions = Omit<RunPersonalWeeklyReportsOptions, "targetDate" | "reportMonth"> & { month?: string };

export function runCompanyMonthlyReport(options: CompanyMonthlyReportOptions) {
  return runCompanyWeeklyReport({ ...options, reportMonth: completedReportMonth(options.month).month });
}
export function runPersonalMonthlyReports(options: PersonalMonthlyReportOptions) {
  return runPersonalWeeklyReports({ ...options, reportMonth: completedReportMonth(options.month).month });
}
