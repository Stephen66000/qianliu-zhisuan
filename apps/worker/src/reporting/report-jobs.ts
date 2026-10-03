import { sql, type Kysely } from "kysely";
import type { Database } from "@qianliu/database";
import { UsageOverviewRepository } from "@qianliu/database";
import { WecomAppClient, type EndpointConfig } from "../runtime-assurance/wecom-client.js";
import {
  formatDateRange,
  formatLatestRequestTime,
  formatModelName,
  formatNumber,
  formatPercentage,
  formatTokenVolume,
} from "./format-utils.js";
import { renderSvgToPng } from "./render-png.js";
import {
  generateCompanyWeeklySvg,
  type CompanyWeeklyReportData,
} from "./templates/company-weekly-svg.js";
import {
  generatePersonalWeeklySvg,
  type PersonalWeeklyReportData,
} from "./templates/personal-weekly-svg.js";

import { completedReportMonth, queryMonthEndAllocation } from "./monthly-period.js";
import { pickPersonalWeeklyQuote } from "./quote-library.js";

export interface ModelUsageSummary {
  model: string;
  tokens: number;
  requestCount: number;
}

/**
 * 统计指定时间范围内企业的模型消耗分布
 */
export async function queryTopModelsForRange(
  db: Kysely<Database>,
  enterpriseId: string,
  rangeStart: Date,
  rangeEnd: Date,
  principalId?: string,
  limit: number = 5,
  employeesOnly: boolean = false,
): Promise<ModelUsageSummary[]> {
  try {
    const principalFilter = principalId ? sql`AND lt.principal_id = ${principalId}` : sql``;
    const employeeFilter = employeesOnly ? sql`AND EXISTS (SELECT 1 FROM principal pr WHERE pr.id=ar.principal_id AND pr.enterprise_id=ar.enterprise_id AND pr.type='EMPLOYEE')` : sql``;
    const result = await sql<{
      model_name: string | null;
      request_count: string | number | bigint;
      total_tokens: string | number | bigint;
    }>`
      SELECT COALESCE(um.display_name, ar.unified_model) AS model_name,
             COUNT(ar.id) AS request_count,
             COALESCE(SUM(lt.total_input_tokens + lt.total_output_tokens), 0) AS total_tokens
        FROM ledger_transaction lt
        JOIN ai_request ar
          ON ar.id = lt.ai_request_id AND ar.enterprise_id = lt.enterprise_id
        LEFT JOIN unified_model um
          ON (um.id = ar.unified_model_id OR um.alias = ar.unified_model)
         AND um.enterprise_id = ar.enterprise_id
       WHERE lt.enterprise_id = ${enterpriseId}
         AND lt.status = 'SETTLED'
         AND ar.status = 'SUCCEEDED'
         AND lt.created_at >= ${rangeStart}
         AND lt.created_at < ${rangeEnd}
         ${principalFilter}
         ${employeeFilter}
       GROUP BY COALESCE(um.display_name, ar.unified_model)
       ORDER BY total_tokens DESC, request_count DESC
       LIMIT ${limit}
    `.execute(db);

    const rows = result.rows || [];
    if (rows.length > 0) {
      return rows.map((r) => ({
        model: formatModelName(r.model_name ?? "通用模型"),
        tokens: Number(r.total_tokens ?? 0),
        requestCount: Number(r.request_count ?? 0),
      }));
    }
    if (employeesOnly) return []; // Closed-month reports use the same settled facts as their totals.

    // 备用兜底查询 usage_event
    const fallbackRows = await db
      .selectFrom("ai_request as r")
      .innerJoin("usage_event as u", "u.ai_request_id", "r.id")
      .leftJoin("unified_model as um", (join) =>
        join.on((eb) =>
          eb.and([
            eb("um.enterprise_id", "=", eb.ref("r.enterprise_id")),
            eb.or([
              eb("um.id", "=", eb.ref("r.unified_model_id")),
              eb("um.alias", "=", eb.ref("r.unified_model")),
            ]),
          ]),
        ),
      )
      .select([
        sql<string>`COALESCE(um.display_name, r.unified_model)`.as("unified_model"),
        sql<string>`coalesce(sum(u.input_tokens + u.output_tokens), 0)`.as("total_tokens"),
        sql<string>`count(r.id)`.as("req_count"),
      ])
      .where("r.enterprise_id", "=", enterpriseId)
      .where("r.status", "=", "SUCCEEDED")
      .where("r.started_at", ">=", rangeStart)
      .where("r.started_at", "<", rangeEnd)
      .$if(employeesOnly, qb => qb.where(sql<boolean>`EXISTS (SELECT 1 FROM principal pr WHERE pr.id=r.principal_id AND pr.enterprise_id=r.enterprise_id AND pr.type='EMPLOYEE')`))
      .$if(Boolean(principalId), (qb) => qb.where("r.principal_id", "=", principalId!))
      .groupBy(sql`COALESCE(um.display_name, r.unified_model)`)
      .orderBy(sql`sum(u.input_tokens + u.output_tokens)`, "desc")
      .limit(limit)
      .execute();

    return fallbackRows.map((m) => ({
      model: formatModelName(m.unified_model),
      tokens: Number(m.total_tokens),
      requestCount: Number(m.req_count),
    }));
  } catch {
    return [];
  }
}

/**
 * 查询企业月度 Token 额度汇总（全部有效授权 quota_value 与已扣减 used_value）
 * 用于全员周报第 1 行大数字：本月总 Token / 剩余 Token 总量
 */
export async function queryEnterpriseQuotaSummary(
  db: Kysely<Database>,
  enterpriseId: string,
): Promise<{ quotaTotal: number; quotaUsed: number }> {
  try {
    const row = await db
      .selectFrom("principal_grant as g")
      .leftJoin("quota_counter as c", "c.grant_id", "g.id")
      .select([
        sql<string>`coalesce(sum(g.quota_value), 0)`.as("quota_total"),
        sql<string>`coalesce(sum(c.used_value), 0)`.as("quota_used"),
      ])
      .where("g.enterprise_id", "=", enterpriseId)
      .where("g.status", "=", "ACTIVE")
      .executeTakeFirst();

    return {
      quotaTotal: Number(row?.quota_total ?? 0),
      quotaUsed: Number(row?.quota_used ?? 0),
    };
  } catch {
    return { quotaTotal: 0, quotaUsed: 0 };
  }
}

/**
 * 查询员工在统计区间内的最晚物理调用时间
 */
export async function queryLatestRequestTime(
  db: Kysely<Database>,
  enterpriseId: string,
  principalId: string,
  rangeStart: Date,
  rangeEnd: Date,
  timezone: string,
): Promise<string> {
  try {
    const row = await db
      .selectFrom("ai_request")
      .select("started_at")
      .where("enterprise_id", "=", enterpriseId)
      .where("principal_id", "=", principalId)
      .where("status", "=", "SUCCEEDED")
      .where("started_at", ">=", rangeStart)
      .where("started_at", "<", rangeEnd)
      .orderBy("started_at", "desc")
      .limit(1)
      .executeTakeFirst();

    if (row?.started_at) {
      return formatLatestRequestTime(new Date(row.started_at), timezone);
    }
  } catch {
    // 忽略异常，降级返回默认值
  }
  return "周内深度协同";
}

/**
 * 解析企微接收人：支持企微 provider_user_id、员工姓名、员工邮箱或 person_id 自动映射
 */
export async function resolveWecomRecipients(
  db: Kysely<Database>,
  enterpriseId: string,
  rawRecipients: string[],
): Promise<string[]> {
  const resolvedRecipients: string[] = [];
  for (const rawItem of rawRecipients) {
    const item = rawItem.trim();
    if (!item) continue;

    // a. 优先精确匹配已有企微 provider_user_id
    const byUserId = await db
      .selectFrom("person_external_identity")
      .select("provider_user_id")
      .where("enterprise_id", "=", enterpriseId)
      .where("provider", "=", "WECOM")
      .where("status", "=", "ACTIVE")
      .where("provider_user_id", "=", item)
      .executeTakeFirst();
    if (byUserId) {
      resolvedRecipients.push(byUserId.provider_user_id);
      continue;
    }

    // b. 匹配员工姓名、邮箱或 person_id
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(item);
    const byPerson = await db
      .selectFrom("person_external_identity as pei")
      .innerJoin("person as p", "p.id", "pei.person_id")
      .select("pei.provider_user_id")
      .where("pei.enterprise_id", "=", enterpriseId)
      .where("pei.provider", "=", "WECOM")
      .where("pei.status", "=", "ACTIVE")
      .where((eb) => {
        const conds = [
          eb("p.name", "=", item),
          eb("p.name", "like", `%${item}%`),
          eb("p.email", "=", item),
        ];
        if (isUuid) {
          conds.push(eb("p.id", "=", item));
        }
        return eb.or(conds);
      })
      .executeTakeFirst();
    if (byPerson) {
      resolvedRecipients.push(byPerson.provider_user_id);
      continue;
    }

    // c. 兜底保留原值（直接作为企业微信账号）
    resolvedRecipients.push(item);
  }
  return Array.from(new Set(resolvedRecipients));
}

function periodicContext(db: Kysely<Database>, options: { reportMonth?: string; targetDate?: Date }, enterpriseTimezone: string | null) {
  const monthly = options.reportMonth ? completedReportMonth(options.reportMonth) : null;
  const timezone = monthly ? "Asia/Shanghai" : enterpriseTimezone || "Asia/Shanghai";
  const anchorDate = monthly?.anchor ?? options.targetDate ?? new Date(Date.now() - 24 * 3600_000);
  return { monthly, timezone, anchorDate, divisor: monthly?.days ?? 7,
    period: monthly ? "MONTH" as const : "WEEK" as const,
    noun: monthly ? "月" : "周", fileKind: monthly ? "monthly" : "weekly",
    quotaCaption: monthly ? "当月分配额度" : "本月总 Token",
    consumedCaption: monthly ? "额度扣减总量" : "Token 消耗总量（本月）",
    remainingCaption: monthly ? "月末剩余额度" : "剩余 Token 总量",
    usageRepo: monthly ? new UsageOverviewRepository(db) : new UsageOverviewRepository(db, () => anchorDate),
    dateRange: (start: Date, end: Date) => monthly?.dateRange ?? formatDateRange(start, new Date(end.getTime() - 1000), timezone) };
}

async function companyQuotaView(db: Kysely<Database>, enterpriseId: string, monthly: ReturnType<typeof completedReportMonth> | null, deductedQuota: string, consumedTokens: number) {
  const current = monthly ? null : await queryEnterpriseQuotaSummary(db, enterpriseId);
  const total = monthly ? await queryMonthEndAllocation(db, enterpriseId, monthly.end) : current!.quotaTotal;
  const used = monthly ? Number(deductedQuota) : current!.quotaUsed;
  const remaining = total === null ? null : Math.max(0, total - used);
  return { total: total === null ? "未留存" : formatTokenVolume(total),
    remaining: remaining === null ? "未留存" : formatTokenVolume(remaining),
    consumed: formatTokenVolume(monthly ? used : consumedTokens) };
}

export interface RunCompanyWeeklyReportOptions {
  db: Kysely<Database>;
  kekBase64: string;
  enterpriseId: string;
  targetDate?: Date; // 默认为上周某天（即以当前时间推算的上周自然周）
  recipients?: string[];
  dryRun?: boolean;
  /** @internal Supplied by the completed-month wrappers. */
  reportMonth?: string;
}

export interface RunCompanyWeeklyReportResult {
  enterpriseName: string;
  dateRange: string;
  totalTokens: number;
  requestCount: number;
  activeEmployees: number;
  recipients: string[];
  mediaId?: string;
  status: "SENT" | "DRY_RUN" | "NO_RECIPIENTS" | "NO_ACTIVE_ENDPOINT";
  svg?: string;
  pngBuffer?: Buffer;
}

/**
 * 运行团队全员用量周报推送作业（每周一 09:00 或 CLI 触发）
 */
export async function runCompanyWeeklyReport(
  options: RunCompanyWeeklyReportOptions,
): Promise<RunCompanyWeeklyReportResult> {
  const { db, kekBase64, enterpriseId, dryRun = false } = options;

  const enterprise = await db
    .selectFrom("enterprise")
    .select(["id", "name", "timezone"])
    .where("id", "=", enterpriseId)
    .executeTakeFirst();

  if (!enterprise) {
    throw new Error(`Enterprise not found: ${enterpriseId}`);
  }

  const context = periodicContext(db, options, enterprise.timezone);
  const { monthly, timezone, anchorDate, usageRepo, divisor } = context;
  const overview = await usageRepo.getOverview({
    enterpriseId,
    subjectType: "EMPLOYEE",
    period: context.period,
    timezone,
    anchor: anchorDate,
  });

  const rangeStart = new Date(overview.range.from);
  const rangeEnd = new Date(overview.range.to);
  const dateRangeStr = context.dateRange(rangeStart, rangeEnd);

  const totalTokens = Number(overview.metrics.realTokens);
  const requestCount = Number(overview.metrics.requestCount);
  const activeEmployees = overview.metrics.activeSubjects;

  // 月度额度视角：本月总 Token（有效授权额度合计）、本月消耗总量（账本真实 Token）、剩余 Token 总量
  const monthOverview = await usageRepo.getOverview({
    enterpriseId,
    subjectType: "EMPLOYEE",
    period: "MONTH",
    timezone,
    anchor: anchorDate,
  });
  const monthConsumed = Number(monthOverview.metrics.realTokens);
  const quota = await companyQuotaView(db, enterpriseId, monthly, overview.metrics.deductedQuota, monthConsumed);

  // 1. 查询模型消耗 Top 3
  const topModelsData = await queryTopModelsForRange(db, enterpriseId, rangeStart, rangeEnd, undefined, 3, Boolean(monthly));
  const totalModelTokens = monthly ? totalTokens : topModelsData.reduce((acc, m) => acc + m.tokens, 0);

  const topModels = topModelsData.map((m) => {
    const share = totalModelTokens > 0 ? `${((m.tokens / totalModelTokens) * 100).toFixed(1)}%` : "0.0%";
    return {
      model: m.model,
      tokens: formatTokenVolume(m.tokens),
      dailyTokens: formatTokenVolume(m.tokens / divisor, { isDailyAvg: true }),
      requests: formatNumber(m.requestCount),
      share,
    };
  });

  // 2. 组装成员排名 Top 7
  const topUsers = overview.ranking.slice(0, 7).map((u, idx) => {
    const uTokens = Number(u.realTokens);
    return {
      rank: idx + 1,
      name: u.subjectName,
      department: u.departmentLabel ?? "核心团队",
      requests: formatNumber(u.requestCount),
      tokens: formatTokenVolume(uTokens),
      dailyTokens: formatTokenVolume(uTokens / divisor, { isDailyAvg: true }),
      share: formatPercentage(u.share),
    };
  });

  const reportData: CompanyWeeklyReportData = {
    enterpriseName: enterprise.name,
    dateRange: dateRangeStr,
    reportMonth: monthly?.label,
    monthQuotaTotal: quota.total,
    monthConsumedTokens: quota.consumed,
    monthQuotaRemaining: quota.remaining,
    totalRequests: `${formatNumber(requestCount)} 次`,
    totalTokens: formatTokenVolume(totalTokens),
    dailyAvgTokens: formatTokenVolume(totalTokens / divisor, { isDailyAvg: true }),
    totalEmployees: activeEmployees,
    topUsers,
    topModels,
  };

  const svg = generateCompanyWeeklySvg(reportData);
  const pngBuffer = await renderSvgToPng(svg, { fitWidth: 1080 });

  // 3. 确定接收人列表
  let recipients = options.recipients;
  if (!recipients || recipients.length === 0) {
    const envRecipients = process.env.WECOM_COMPANY_REPORT_RECIPIENTS || process.env.WECOM_DAILY_REPORT_RECIPIENTS;
    if (envRecipients && envRecipients.trim().length > 0) {
      recipients = envRecipients.split(",").map((s) => s.trim()).filter(Boolean);
    } else {
      const adminIdentities = await db
        .selectFrom("person_external_identity as pei")
        .innerJoin("person as p", "p.id", "pei.person_id")
        .innerJoin("admin_user as a", (join) =>
          join.onRef("a.enterprise_id", "=", "pei.enterprise_id").on((eb) =>
            eb.or([
              eb("a.username", "=", eb.ref("p.email")),
              eb("a.username", "=", eb.ref("p.name")),
            ]),
          ),
        )
        .select("pei.provider_user_id")
        .where("pei.enterprise_id", "=", enterpriseId)
        .where("pei.provider", "=", "WECOM")
        .where("pei.status", "=", "ACTIVE")
        .where("a.status", "=", "ACTIVE")
        .execute();

      recipients = adminIdentities.map((row) => row.provider_user_id);
    }
  }

  // 兜底：若系统管理员未关联企微身份，自动将全员周报默认指定发送给李佳
  if (!recipients || recipients.length === 0) {
    const defaultIdentity = await db
      .selectFrom("person_external_identity as pei")
      .innerJoin("person as p", "p.id", "pei.person_id")
      .select("pei.provider_user_id")
      .where("pei.enterprise_id", "=", enterpriseId)
      .where("pei.provider", "=", "WECOM")
      .where("pei.status", "=", "ACTIVE")
      .where((eb) => eb.or([eb("p.name", "=", "李佳"), eb("p.name", "like", "%李佳%")]))
      .executeTakeFirst();
    if (defaultIdentity?.provider_user_id) {
      recipients = [defaultIdentity.provider_user_id];
    }
  }

  // 4. 解析接收人：支持企微 UserID、员工姓名、邮箱自动匹配转换
  if (recipients && recipients.length > 0) {
    recipients = await resolveWecomRecipients(db, enterpriseId, recipients);
  }

  if (dryRun) {
    return {
      enterpriseName: enterprise.name,
      dateRange: dateRangeStr,
      totalTokens,
      requestCount,
      activeEmployees,
      recipients: recipients ?? [],
      status: "DRY_RUN",
      svg,
      pngBuffer,
    };
  }

  if (!recipients || recipients.length === 0) {
    return {
      enterpriseName: enterprise.name,
      dateRange: dateRangeStr,
      totalTokens,
      requestCount,
      activeEmployees,
      recipients: [],
      status: "NO_RECIPIENTS",
    };
  }

  const endpoint = await db
    .selectFrom("notification_endpoint")
    .selectAll()
    .where("provider", "=", "WECOM_APP")
    .where("status", "=", "ACTIVE")
    .executeTakeFirst();

  if (!endpoint) {
    return {
      enterpriseName: enterprise.name,
      dateRange: dateRangeStr,
      totalTokens,
      requestCount,
      activeEmployees,
      recipients,
      status: "NO_ACTIVE_ENDPOINT",
    };
  }

  const client = new WecomAppClient(kekBase64);
  const mediaId = await client.uploadMedia(
    endpoint as EndpointConfig,
    pngBuffer,
    `company_${context.fileKind}_${dateRangeStr.replace(/\s+/g, "")}.png`,
  );

  await client.sendImageMessage(endpoint as EndpointConfig, recipients, mediaId);

  const summaryText = [
    `📊 【${enterprise.name}】全员用量${context.noun}报小结 (${dateRangeStr})`,
    "━━━━━━━━━━━━━━━━━━",
    `💎 ${context.quotaCaption}：${quota.total}`,
    `🔥 ${context.consumedCaption}：${quota.consumed}`,
    `🧮 ${context.remainingCaption}：${quota.remaining}`,
    `⚡ 全${context.noun}消耗总量：${formatTokenVolume(totalTokens)}`,
    `📈 日均使用水平：${formatTokenVolume(totalTokens / divisor, { isDailyAvg: true })}`,
    `🚀 全${context.noun}总请求数：${formatNumber(requestCount)} 次`,
    `👥 活跃员工总数：${activeEmployees} 人`,
    "━━━━━━━━━━━━━━━━━━",
    "详见上方管理看板长图 👆",
  ].join("\n");

  await client.sendTextMessage(endpoint as EndpointConfig, recipients, summaryText);

  return {
    enterpriseName: enterprise.name,
    dateRange: dateRangeStr,
    totalTokens,
    requestCount,
    activeEmployees,
    recipients,
    mediaId,
    status: "SENT",
  };
}

export interface RunPersonalWeeklyReportsOptions {
  db: Kysely<Database>;
  kekBase64: string;
  enterpriseId: string;
  targetDate?: Date;
  userPersonId?: string;
  shouldSend?: (principalId: string) => Promise<boolean>;
  onSent?: (principalId: string) => Promise<void>;
  dryRun?: boolean;
  /** @internal Supplied by the completed-month wrappers. */
  reportMonth?: string;
}

export interface PersonalWeeklyItemResult {
  personId: string;
  userName: string;
  providerUserId?: string;
  totalTokens: number;
  requestCount: number;
  status: "SENT" | "DRY_RUN" | "NO_WECOM_IDENTITY" | "NO_ACTIVE_ENDPOINT";
  mediaId?: string;
  svg?: string;
}

/**
 * 运行员工个人周报信笺推送作业（每周一 09:00 或 CLI 触发）
 */
// eslint-disable-next-line complexity -- 已登记例外（2026-09-14 I1 审核）：周报编排分支密集，随 report-jobs.ts 711 行体量拆分（F-P2-3）一并处理。
export async function runPersonalWeeklyReports(
  options: RunPersonalWeeklyReportsOptions,
): Promise<PersonalWeeklyItemResult[]> {
  const { db, kekBase64, enterpriseId, userPersonId, dryRun = false } = options;

  const enterprise = await db
    .selectFrom("enterprise")
    .select(["id", "name", "timezone"])
    .where("id", "=", enterpriseId)
    .executeTakeFirst();

  if (!enterprise) {
    throw new Error(`Enterprise not found: ${enterpriseId}`);
  }

  const monthly = options.reportMonth ? completedReportMonth(options.reportMonth) : null;
  const timezone = monthly ? "Asia/Shanghai" : enterprise.timezone || "Asia/Shanghai";
  const now = new Date();
  const anchorDate = monthly?.anchor ?? options.targetDate ?? new Date(now.getTime() - 24 * 3600_000);

  const usageRepo = monthly ? new UsageOverviewRepository(db) : new UsageOverviewRepository(db, () => anchorDate);
  const overview = await usageRepo.getOverview({
    enterpriseId,
    subjectType: "EMPLOYEE",
    period: monthly ? "MONTH" : "WEEK",
    ...(monthly ? { timezone: "Asia/Shanghai" } : {}),
    anchor: anchorDate,
  });

  const rangeStart = new Date(overview.range.from);
  const rangeEnd = new Date(overview.range.to);
  const dateRangeStr = monthly?.dateRange ?? formatDateRange(rangeStart, new Date(rangeEnd.getTime() - 1000), timezone);
  const divisor = monthly?.days ?? 7;
  const weekLabel = `${monthly ? "月度小结" : "一周小结"} ${dateRangeStr}`;

  // 筛选需要推送的员工列表
  let targetRanking: typeof overview.ranking = [];
  if (userPersonId) {
    const matched = overview.ranking.filter(
      (r) =>
        r.subjectId === userPersonId ||
        r.subjectName === userPersonId ||
        r.subjectName.includes(userPersonId),
    );
    if (matched.length > 0) {
      targetRanking = matched;
    } else {
      const identity = await db
        .selectFrom("person_external_identity as pei")
        .innerJoin("principal as pr", "pr.person_id", "pei.person_id")
        .select("pr.id as principal_id")
        .where("pei.enterprise_id", "=", enterpriseId)
        .where((eb) =>
          eb.or([
            eb("pei.provider_user_id", "=", userPersonId),
            eb("pei.person_id", "=", userPersonId),
          ]),
        )
        .executeTakeFirst();
      const principalId = identity?.principal_id;
      if (principalId) {
        const found = overview.ranking.find((r) => r.subjectId === principalId);
        if (found) {
          targetRanking = [found];
        } else {
          const personRow = await db
            .selectFrom("person as p")
            .innerJoin("principal as pr", "pr.person_id", "p.id")
            .select(["pr.id as principal_id", "p.name as person_name"])
            .where("pr.enterprise_id", "=", enterpriseId)
            .where("pr.id", "=", principalId)
            .executeTakeFirst();
          if (personRow) {
            targetRanking = [{
              subjectId: personRow.principal_id,
              subjectName: personRow.person_name,
              departmentLabel: "—",
              requestCount: "0",
              inputTokens: "0",
              outputTokens: "0",
              cacheTokens: "0",
              reasoningTokens: "0",
              realTokens: "0",
              share: "0",
              apiCost: "0",
              apiCostStatus: "CONFIRMED_ZERO_NO_UPSTREAM",
              deductedQuota: "0",
              allocatedQuota: "0",
              usageQuality: "NO_DATA",
              providerReportedCount: 0,
              estimatedCount: 0,
              accountAggregatedCount: 0,
              mixedCount: 0,
              unknownCount: 0,
            }];
          }
        }
      } else {
        const personRow = await db
          .selectFrom("person as p")
          .innerJoin("principal as pr", "pr.person_id", "p.id")
          .select(["pr.id as principal_id", "p.name as person_name"])
          .where("pr.enterprise_id", "=", enterpriseId)
          .where("p.name", "=", userPersonId)
          .executeTakeFirst();
        if (personRow) {
          targetRanking = [{
            subjectId: personRow.principal_id,
            subjectName: personRow.person_name,
            departmentLabel: "—",
            requestCount: "0",
            inputTokens: "0",
            outputTokens: "0",
            cacheTokens: "0",
            reasoningTokens: "0",
            realTokens: "0",
            share: "0",
            apiCost: "0",
            apiCostStatus: "CONFIRMED_ZERO_NO_UPSTREAM",
            deductedQuota: "0",
            allocatedQuota: "0",
            usageQuality: "NO_DATA",
            providerReportedCount: 0,
            estimatedCount: 0,
            accountAggregatedCount: 0,
            mixedCount: 0,
            unknownCount: 0,
          }];
        }
      }
    }
  } else {
    targetRanking = overview.ranking.filter((r) => Number(r.realTokens) > 0);
  }

  if (targetRanking.length === 0) {
    return [];
  }

  // 查询活跃 Endpoint
  const endpoint = dryRun
    ? null
    : await db
        .selectFrom("notification_endpoint")
        .selectAll()
        .where("provider", "=", "WECOM_APP")
        .where("status", "=", "ACTIVE")
        .executeTakeFirst();

  const client = dryRun ? null : new WecomAppClient(kekBase64);
  const results: PersonalWeeklyItemResult[] = [];

  for (const item of targetRanking) {
    const principalId = item.subjectId;
    if (!dryRun && options.shouldSend && !await options.shouldSend(principalId)) continue;
    const tokens = Number(item.realTokens);
    const requests = Number(item.requestCount);

    // 查询该员工企微身份
    const identity = await db
      .selectFrom("person_external_identity as pei")
      .innerJoin("principal as pr", "pr.person_id", "pei.person_id")
      .select(["pei.provider_user_id", "pei.person_id"])
      .where("pr.id", "=", principalId)
      .where("pei.enterprise_id", "=", enterpriseId)
      .where("pei.provider", "=", "WECOM")
      .where("pei.status", "=", "ACTIVE")
      .executeTakeFirst();

    // 查询最晚物理调用时间与主力模型
    const latest = await queryLatestRequestTime(db, enterpriseId, principalId, rangeStart, rangeEnd, timezone);
    const latestTime = monthly && latest === "周内深度协同" ? "月内暂无成功请求" : latest;
    const userModels = await queryTopModelsForRange(db, enterpriseId, rangeStart, rangeEnd, principalId, 1, Boolean(monthly));
    const topModelName = userModels[0]?.model;

    // 计算当月剩余额度（本月分配额度 - 本月使用额度）
    const currentYear = rangeStart.getFullYear();
    const currentMonth = rangeStart.getMonth();
    const monthStart = new Date(Date.UTC(currentYear, currentMonth, 1));
    const nextMonthStart = new Date(Date.UTC(currentYear, currentMonth + 1, 1));

    const grantRow = monthly ? null : await sql<{ allocated_quota: string }>`
      SELECT COALESCE(SUM(quota_value), 0)::text AS allocated_quota
        FROM principal_grant
       WHERE enterprise_id = ${enterpriseId}
         AND principal_id = ${principalId}
         AND status = 'ACTIVE'
         AND (valid_until IS NULL OR valid_until > ${rangeEnd})
    `.execute(db);
    const allocatedQuotaNum = monthly ? await queryMonthEndAllocation(db, enterpriseId, monthly.end, principalId)
      : Number(grantRow?.rows[0]?.allocated_quota ?? 0);

    const monthUsageRow = monthly ? null : await sql<{ month_tokens: string }>`
      SELECT COALESCE(SUM(lt.total_input_tokens + lt.total_output_tokens), 0)::text AS month_tokens
        FROM ledger_transaction lt
       WHERE lt.enterprise_id = ${enterpriseId}
         AND lt.principal_id = ${principalId}
         AND lt.status = 'SETTLED'
         AND lt.created_at >= ${monthStart}
         AND lt.created_at < ${nextMonthStart}
    `.execute(db);
    const monthTokensNum = monthly ? Number(item.deductedQuota) : Number(monthUsageRow?.rows[0]?.month_tokens ?? 0);

    let remainingQuotaValue = "不限";
    if (allocatedQuotaNum === null) remainingQuotaValue = "历史额度未留存";
    else if (allocatedQuotaNum > 0) {
      const remaining = allocatedQuotaNum - monthTokensNum;
      remainingQuotaValue = remaining > 0 ? formatTokenVolume(remaining) : "0 (已超额)";
    }

    const metrics = [
      {
        label: "总请求次数",
        value: `${formatNumber(requests)} 次`,
      },
      {
        label: `${monthly ? "月" : "周"}消耗 Token 总量`,
        value: formatTokenVolume(tokens),
      },
      {
        label: "日均使用量",
        value: formatTokenVolume(tokens / divisor, { isDailyAvg: true }),
      },
      {
        label: "最晚请求时间",
        value: latestTime,
      },
      {
        label: monthly ? "月末剩余额度" : "本月剩余额度",
        value: remainingQuotaValue,
      },
    ];

    if (topModelName) {
      metrics.push({
        label: "核心主力模型",
        value: topModelName,
      });
    }

    const cardData: PersonalWeeklyReportData = {
      userName: item.subjectName,
      dateRange: weekLabel,
      quote: pickPersonalWeeklyQuote(item.subjectName, rangeStart),
      metrics,
    };

    const svg = generatePersonalWeeklySvg(cardData);

    if (dryRun) {
      results.push({
        personId: identity?.person_id ?? principalId,
        userName: item.subjectName,
        providerUserId: identity?.provider_user_id,
        totalTokens: tokens,
        requestCount: requests,
        status: "DRY_RUN",
        svg,
      });
      continue;
    }

    if (!identity?.provider_user_id) {
      results.push({
        personId: principalId,
        userName: item.subjectName,
        totalTokens: tokens,
        requestCount: requests,
        status: "NO_WECOM_IDENTITY",
      });
      continue;
    }

    if (!endpoint || !client) {
      results.push({
        personId: identity.person_id,
        userName: item.subjectName,
        providerUserId: identity.provider_user_id,
        totalTokens: tokens,
        requestCount: requests,
        status: "NO_ACTIVE_ENDPOINT",
      });
      continue;
    }

    const pngBuffer = await renderSvgToPng(svg, { fitWidth: 1080 });
    const mediaId = await client.uploadMedia(
      endpoint as EndpointConfig,
      pngBuffer,
      `${monthly ? "monthly" : "weekly"}_${identity.provider_user_id}.png`,
    );

    await client.sendImageMessage(endpoint as EndpointConfig, [identity.provider_user_id], mediaId);

    const personalSummary = [
      `👋 ${item.subjectName}，您${monthly ? monthly.label : "上一周"}的 AI 协同小结已生成！`,
      "━━━━━━━━━━━━━━━━━━",
      `⚡ ${monthly ? "月" : "周"}总消耗：${formatTokenVolume(tokens)}`,
      `📈 日均用量：${formatTokenVolume(tokens / divisor, { isDailyAvg: true })}`,
      `⏱ 最晚请求：${latestTime}`,
      "━━━━━━━━━━━━━━━━━━",
      "专属记录已送达，快打开看看吧！",
    ].join("\n");

    await client.sendTextMessage(endpoint as EndpointConfig, [identity.provider_user_id], personalSummary);

    if (options.onSent) await options.onSent(principalId);
    results.push({
      personId: identity.person_id,
      userName: item.subjectName,
      providerUserId: identity.provider_user_id,
      totalTokens: tokens,
      requestCount: requests,
      status: "SENT",
      mediaId,
    });
  }

  return results;
}
