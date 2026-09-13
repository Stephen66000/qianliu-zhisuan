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
): Promise<ModelUsageSummary[]> {
  try {
    const principalFilter = principalId ? sql`AND lt.principal_id = ${principalId}` : sql``;
    const result = await sql<{
      model_name: string | null;
      request_count: string | number | bigint;
      total_tokens: string | number | bigint;
    }>`
      SELECT ar.unified_model AS model_name,
             COUNT(ar.id) AS request_count,
             COALESCE(SUM(lt.total_input_tokens + lt.total_output_tokens), 0) AS total_tokens
        FROM ledger_transaction lt
        JOIN ai_request ar
          ON ar.id = lt.ai_request_id AND ar.enterprise_id = lt.enterprise_id
       WHERE lt.enterprise_id = ${enterpriseId}
         AND lt.status = 'SETTLED'
         AND ar.status = 'SUCCEEDED'
         AND lt.created_at >= ${rangeStart}
         AND lt.created_at < ${rangeEnd}
         ${principalFilter}
       GROUP BY ar.unified_model
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

    // 备用兜底查询 usage_event
    const fallbackRows = await db
      .selectFrom("ai_request as r")
      .innerJoin("usage_event as u", "u.ai_request_id", "r.id")
      .select([
        "r.unified_model",
        sql<string>`coalesce(sum(u.input_tokens + u.output_tokens), 0)`.as("total_tokens"),
        sql<string>`count(r.id)`.as("req_count"),
      ])
      .where("r.enterprise_id", "=", enterpriseId)
      .where("r.status", "=", "SUCCEEDED")
      .where("r.started_at", ">=", rangeStart)
      .where("r.started_at", "<", rangeEnd)
      .$if(Boolean(principalId), (qb) => qb.where("r.principal_id", "=", principalId!))
      .groupBy("r.unified_model")
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

export interface RunCompanyWeeklyReportOptions {
  db: Kysely<Database>;
  kekBase64: string;
  enterpriseId: string;
  targetDate?: Date; // 默认为上周某天（即以当前时间推算的上周自然周）
  recipients?: string[];
  dryRun?: boolean;
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

  const timezone = enterprise.timezone || "Asia/Shanghai";
  // 默认锚定上周日（即上周范围内）
  const now = new Date();
  const anchorDate = options.targetDate ?? new Date(now.getTime() - 24 * 3600_000);

  const usageRepo = new UsageOverviewRepository(db, () => anchorDate);
  const overview = await usageRepo.getOverview({
    enterpriseId,
    subjectType: "EMPLOYEE",
    period: "WEEK",
    anchor: anchorDate,
  });

  const rangeStart = new Date(overview.range.from);
  const rangeEnd = new Date(overview.range.to);
  const dateRangeStr = formatDateRange(rangeStart, new Date(rangeEnd.getTime() - 1000), timezone);

  const totalTokens = Number(overview.metrics.realTokens);
  const requestCount = Number(overview.metrics.requestCount);
  const activeEmployees = overview.metrics.activeSubjects;

  // 1. 查询模型消耗 Top 3
  const topModelsData = await queryTopModelsForRange(db, enterpriseId, rangeStart, rangeEnd, undefined, 3);
  const totalModelTokens = topModelsData.reduce((acc, m) => acc + m.tokens, 0);

  const topModels = topModelsData.map((m) => {
    const share = totalModelTokens > 0 ? `${((m.tokens / totalModelTokens) * 100).toFixed(1)}%` : "0.0%";
    return {
      model: m.model,
      tokens: formatTokenVolume(m.tokens),
      dailyTokens: formatTokenVolume(m.tokens / 7, { isDailyAvg: true }),
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
      dailyTokens: formatTokenVolume(uTokens / 7, { isDailyAvg: true }),
      share: formatPercentage(u.share),
    };
  });

  const reportData: CompanyWeeklyReportData = {
    enterpriseName: enterprise.name,
    dateRange: dateRangeStr,
    totalRequests: `${formatNumber(requestCount)} 次`,
    totalTokens: formatTokenVolume(totalTokens),
    dailyAvgTokens: formatTokenVolume(totalTokens / 7, { isDailyAvg: true }),
    totalEmployees: activeEmployees,
    topUsers,
    topModels,
  };

  const svg = generateCompanyWeeklySvg(reportData);
  const pngBuffer = renderSvgToPng(svg);

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
    `company_weekly_${dateRangeStr.replace(/\s+/g, "")}.png`,
  );

  await client.sendImageMessage(endpoint as EndpointConfig, recipients, mediaId);

  const summaryText = [
    `📊 【${enterprise.name}】全员用量周报小结 (${dateRangeStr})`,
    "━━━━━━━━━━━━━━━━━━",
    `⚡ 全周消耗总量：${formatTokenVolume(totalTokens)}`,
    `📈 日均使用水平：${formatTokenVolume(totalTokens / 7, { isDailyAvg: true })}`,
    `🚀 全周总请求数：${formatNumber(requestCount)} 次`,
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
  dryRun?: boolean;
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

  const timezone = enterprise.timezone || "Asia/Shanghai";
  const now = new Date();
  const anchorDate = options.targetDate ?? new Date(now.getTime() - 24 * 3600_000);

  const usageRepo = new UsageOverviewRepository(db, () => anchorDate);
  const overview = await usageRepo.getOverview({
    enterpriseId,
    subjectType: "EMPLOYEE",
    period: "WEEK",
    anchor: anchorDate,
  });

  const rangeStart = new Date(overview.range.from);
  const rangeEnd = new Date(overview.range.to);
  const dateRangeStr = formatDateRange(rangeStart, new Date(rangeEnd.getTime() - 1000), timezone);
  const weekLabel = `一周小结 ${dateRangeStr}`;

  // 筛选需要推送的员工列表
  let targetRanking = overview.ranking.filter((r) => Number(r.realTokens) > 0);
  if (userPersonId) {
    const matched = targetRanking.filter(
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
      if (identity?.principal_id) {
        targetRanking = targetRanking.filter((r) => r.subjectId === identity.principal_id);
      } else {
        targetRanking = [];
      }
    }
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
    const latestTime = await queryLatestRequestTime(db, enterpriseId, principalId, rangeStart, rangeEnd, timezone);
    const userModels = await queryTopModelsForRange(db, enterpriseId, rangeStart, rangeEnd, principalId, 1);
    const topModelName = userModels[0]?.model;

    const metrics = [
      {
        label: "总请求次数",
        value: `${formatNumber(requests)} 次`,
      },
      {
        label: "周消耗 Token 总量",
        value: formatTokenVolume(tokens),
      },
      {
        label: "日均使用量",
        value: formatTokenVolume(tokens / 7, { isDailyAvg: true }),
      },
      {
        label: "最晚请求时间",
        value: latestTime,
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

    const pngBuffer = renderSvgToPng(svg);
    const mediaId = await client.uploadMedia(
      endpoint as EndpointConfig,
      pngBuffer,
      `weekly_${identity.provider_user_id}.png`,
    );

    await client.sendImageMessage(endpoint as EndpointConfig, [identity.provider_user_id], mediaId);

    const personalSummary = [
      `👋 ${item.subjectName}，您上一周的 AI 协同小结已生成！`,
      "━━━━━━━━━━━━━━━━━━",
      `⚡ 周总消耗：${formatTokenVolume(tokens)}`,
      `📈 日均用量：${formatTokenVolume(tokens / 7, { isDailyAvg: true })}`,
      `⏱ 最晚请求：${latestTime}`,
      "━━━━━━━━━━━━━━━━━━",
      "专属信笺白卡已送达上方 👆，新的一周继续加油！",
    ].join("\n");

    await client.sendTextMessage(endpoint as EndpointConfig, [identity.provider_user_id], personalSummary);

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
