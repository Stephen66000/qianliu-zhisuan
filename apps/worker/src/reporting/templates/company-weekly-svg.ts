import { generateCompanyUsageSvg } from "./company-monthly-svg.js";

export interface CompanyWeeklyUserRow {
  rank: number;
  name: string;
  department: string;
  requests: string;    // e.g. "2,840"
  tokens: string;      // e.g. "128.0"
  dailyTokens: string; // e.g. "18.3"
  share: string;       // e.g. "33.3%"
}

export interface CompanyWeeklyModelRow {
  model: string;       // e.g. "DeepSeek V3"
  tokens: string;      // e.g. "235.0"
  dailyTokens: string; // e.g. "33.6"
  requests: string;    // e.g. "6,820"
  share: string;       // e.g. "61.2%"
}

export interface CompanyWeeklyReportData {
  enterpriseName: string;
  reportMonth?: string;
  reportTimezone?: string;
  dateRange: string;      // e.g. "9.7 - 9.13 (第37周)"
  monthTokenUsageRate?: string;
  monthQuotaTotal: string;   // e.g. "500.0"（本月总 Token 额度，万/亿）
  monthConsumedTokens?: string;
  monthQuotaRemaining: string; // e.g. "371.5"（剩余 Token 总量，万/亿）
  totalRequests: string;  // e.g. "10,450"
  totalTokens: string;    // e.g. "384.3"
  dailyAvgTokens: string; // e.g. "54.9"
  totalEmployees?: number; // e.g. 7
  totalModels?: number;
  quotaRows?: Array<{ provider: string; basis: string; detail: string }>;
  quotaAsOf?: string;
  topUsers: CompanyWeeklyUserRow[];
  topModels: CompanyWeeklyModelRow[];
}

/** Team weekly and monthly reports use the same approved layout. */
export function generateCompanyWeeklySvg(data: CompanyWeeklyReportData): string {
  return generateCompanyUsageSvg(data);
}
