import { type Kysely } from "kysely";
import type { Database } from "@qianliu/database";
import { deliverReport, reportRecipientRef, type DeliveryOptions, type DeliveryStatus } from "./delivery.js";
import {
  formatDateRange,
  formatLatestRequestTime,
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

import { completedReportMonth } from "./monthly-period.js";
import { pickPersonalWeeklyQuote } from "./quote-library.js";

export { queryTopModelsForRange, queryModelUsageForRange } from "./model-facts.js";
import { readEmployeeReportFacts } from "./report-facts.js";
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
  includeDate = false,
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
      if (includeDate) {
        const parts = new Intl.DateTimeFormat("zh-CN", { timeZone: timezone, month: "numeric", day: "numeric",
          hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(row.started_at));
        const part = (type: string) => parts.find(item => item.type === type)?.value ?? "";
        return `${part("month")}月${part("day")}日 ${part("hour")}:${part("minute")}`;
      }
      return formatLatestRequestTime(new Date(row.started_at), timezone);
    }
  } catch {
    throw new Error("REPORT_LATEST_REQUEST_FACTS_UNAVAILABLE");
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

function periodicContext(options: { reportMonth?: string; targetDate?: Date } & DeliveryOptions, enterpriseTimezone: string | null) {
  const timezone = enterpriseTimezone || "Asia/Shanghai";
  const monthly = options.reportMonth ? completedReportMonth(options.reportMonth, options.now ?? options.clock?.(), timezone) : null;
  const anchorDate = monthly?.anchor ?? options.targetDate ?? new Date((options.now?.getTime() ?? options.clock?.().getTime() ?? Date.now()) - 24 * 3600_000);
  return { monthly, timezone, anchorDate, divisor: monthly?.days ?? 7,
    period: monthly ? "MONTH" as const : "WEEK" as const,
    noun: monthly ? "月" : "周", fileKind: monthly ? "monthly" : "weekly",
    dateRange: (start: Date, end: Date) => monthly?.dateRange ?? formatDateRange(start, new Date(end.getTime() - 1000), timezone) };
}

export interface RunCompanyWeeklyReportOptions extends DeliveryOptions {
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
  status: DeliveryStatus | "DRY_RUN" | "NO_RECIPIENTS" | "NO_ACTIVE_ENDPOINT";
  svg?: string;
  pngBuffer?: Buffer;
  summaryText?: string;
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

  const context = periodicContext(options, enterprise.timezone);
  const { monthly, timezone, anchorDate, divisor } = context;
  const facts = await readEmployeeReportFacts(db, { enterpriseId, period: context.period, timezone, anchor: anchorDate, now: options.now ?? options.clock?.() });
  const overview = facts.overview;
  const rangeStart = new Date(overview.range.from);
  const rangeEnd = new Date(overview.range.to);
  const dateRangeStr = context.dateRange(rangeStart, rangeEnd);
  const totalTokens = Number(overview.metrics.realTokens);
  const requestCount = Number(overview.metrics.requestCount);
  const activeEmployees = overview.metrics.activeSubjects;
  const quota = facts.quota;
  const topModelsData = facts.models.models;
  const totalModelTokens = totalTokens;

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
    reportTimezone: timezone,
    monthQuotaTotal: quota.scopeLabel,
    monthConsumedTokens: quota.statusLabel,
    monthQuotaRemaining: quota.policyLabel,
    quotaRows: quota.rows,
    quotaAsOf: quota.asOfLabel,
    totalModels: facts.models.totalModels,
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

  const summaryText = [
    `📊 【${enterprise.name}】全员用量${context.noun}报小结 (${dateRangeStr})`,
    "━━━━━━━━━━━━━━━━━━",
    `💎 额度范围：${quota.scopeLabel}`,
    `🔥 额度状态：${quota.statusLabel}`,
    `🧮 超额策略：${quota.policyLabel}`,
    `额度${quota.asOfLabel}；${quota.rows.map(row => `${row.provider}（${row.basis}）：${row.detail}`).join("；")}`,
    "成功请求统计；额度包含失败实耗，按预占归属月计量。",
    `⚡ 全${context.noun}消耗总量：${formatTokenVolume(totalTokens)}`,
    `📈 日均使用水平：${formatTokenVolume(totalTokens / divisor, { isDailyAvg: true })}`,
    `🚀 全${context.noun}总请求数：${formatNumber(requestCount)} 次`,
    `👥 活跃员工总数：${activeEmployees} 人`,
    "━━━━━━━━━━━━━━━━━━",
    "详见上方管理看板长图 👆",
  ].join("\n");

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
      summaryText,
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
      status: "NO_ELIGIBLE_RECIPIENTS",
    };
  }

  const endpoint = await db
    .selectFrom("notification_endpoint")
    .selectAll()
    .where("provider", "=", "WECOM_APP")
    .where("status", "=", "ACTIVE")
    .executeTakeFirst();

  const deliveries = [];
  for (const recipient of recipients) {
    deliveries.push(await deliverReport({ db, kekBase64, enterpriseId,
      type: monthly ? "COMPANY_MONTHLY" : "COMPANY_WEEKLY", periodKey: monthly?.month ?? rangeStart.toISOString(),
      recipientRef: await reportRecipientRef(db, enterpriseId, recipient), targetUserId: recipient, endpointId: endpoint?.id,
      periodStart: rangeStart, periodEnd: rangeEnd,
      snapshot: { facts: facts.snapshotMetadata, png: pngBuffer.toString("base64"), text: summaryText, filename: `company_${context.fileKind}.png` },
      deliveryWindow: options.deliveryWindow, clock: options.clock,
    }));
  }
  const deliveryStatus = deliveries.every(item => item.status === "SENT") ? "SENT"
    : deliveries.some(item => item.status === "UNKNOWN") ? "UNKNOWN" : "DELIVERY_FAILED";

  return {
    enterpriseName: enterprise.name,
    dateRange: dateRangeStr,
    totalTokens,
    requestCount,
    activeEmployees,
    recipients,
    status: deliveryStatus,
  };
}

export interface RunPersonalWeeklyReportsOptions extends DeliveryOptions {
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
  status: DeliveryStatus | "DRY_RUN" | "NO_WECOM_IDENTITY" | "NO_ACTIVE_ENDPOINT";
  mediaId?: string;
  svg?: string;
  summaryText?: string;
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

  const timezone = enterprise.timezone || "Asia/Shanghai";
  const monthly = options.reportMonth ? completedReportMonth(options.reportMonth, options.now ?? options.clock?.(), timezone) : null;
  const now = options.now ?? options.clock?.() ?? new Date();
  const anchorDate = monthly?.anchor ?? options.targetDate ?? new Date(now.getTime() - 24 * 3600_000);

  const facts = await readEmployeeReportFacts(db, { enterpriseId, period: monthly ? "MONTH" : "WEEK", timezone, anchor: anchorDate, now });
  const overview = facts.overview;

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

  const results: PersonalWeeklyItemResult[] = [];

  for (const item of targetRanking) {
    const principalId = item.subjectId;
    try {
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
    const personFacts = facts.personal.get(principalId);
    const latestParts = personFacts?.latest ? new Intl.DateTimeFormat("zh-CN", { timeZone: timezone, month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(personFacts.latest) : [];
    const part = (type: string) => latestParts.find(item => item.type === type)?.value ?? "";
    const latestTime = personFacts?.latest ? `${monthly ? `${part("month")}月${part("day")}日 ` : ""}${part("hour")}:${part("minute")}`
      : `${monthly ? "月" : "周"}内暂无成功请求`;
    const topModelName = personFacts?.model;

    const personalQuota = facts.quotaForPrincipal(principalId);
    const remainingQuotaValue = personalQuota.statusLabel;

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
        label: `额度${personalQuota.asOfLabel}`,
        value: remainingQuotaValue,
      },
    ];

    for (const row of personalQuota.rows) metrics.push({ label: `${row.provider} · ${row.basis}`, value: row.detail });

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

    const personalSummary = [
      `👋 ${item.subjectName}，您${monthly ? monthly.label : "上一周"}的 AI 协同小结已生成！`,
      "━━━━━━━━━━━━━━━━━━",
      `⚡ ${monthly ? "月" : "周"}总消耗：${formatTokenVolume(tokens)}`,
      `📈 日均用量：${formatTokenVolume(tokens / divisor, { isDailyAvg: true })}`,
      `⏱ 最晚请求：${latestTime}`,
      `额度${personalQuota.asOfLabel}：${remainingQuotaValue}`,
      ...personalQuota.rows.map(row => `${row.provider}（${row.basis}）：${row.detail}`),
      "成功请求统计；额度包含失败实耗，按预占归属月计量。",
      "━━━━━━━━━━━━━━━━━━",
      "专属记录已送达，快打开看看吧！",
    ].join("\n");

    if (dryRun) {
      results.push({
        personId: identity?.person_id ?? principalId,
        userName: item.subjectName,
        providerUserId: identity?.provider_user_id,
        totalTokens: tokens,
        requestCount: requests,
        status: "DRY_RUN",
        svg,
        summaryText: personalSummary,
      });
      continue;
    }

    const pngBuffer = await renderSvgToPng(svg, { fitWidth: 1080 });

    const delivery = await deliverReport({ db, kekBase64, enterpriseId,
      type: monthly ? "PERSONAL_MONTHLY" : "PERSONAL_WEEKLY", periodKey: monthly?.month ?? rangeStart.toISOString(),
      recipientRef: principalId, targetUserId: identity?.provider_user_id, endpointId: endpoint?.id,
      periodStart: rangeStart, periodEnd: rangeEnd,
      snapshot: { facts: facts.snapshotMetadata, png: pngBuffer.toString("base64"), text: personalSummary, filename: `${monthly ? "monthly" : "weekly"}_${identity?.provider_user_id ?? principalId}.png` },
      deliveryWindow: options.deliveryWindow, clock: options.clock,
    });

    if (delivery.status === "SENT" && options.onSent) await options.onSent(principalId);
    results.push({
      personId: identity?.person_id ?? principalId,
      userName: item.subjectName,
      providerUserId: identity?.provider_user_id,
      totalTokens: tokens,
      requestCount: requests,
      status: delivery.status,
    });
    } catch (error) {
      console.error(JSON.stringify({ event: "personal_report_recipient_blocked", enterprise_id: enterpriseId,
        principal_id: principalId, error_type: error instanceof Error ? error.name : typeof error }));
      results.push({ personId: principalId, userName: item.subjectName, totalTokens: Number(item.realTokens),
        requestCount: Number(item.requestCount), status: "DELIVERY_FAILED" });
    }
  }

  return results;
}
