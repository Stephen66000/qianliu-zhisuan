import type { Kysely } from "kysely";
import type { Database } from "@qianliu/database";
import { UsageOverviewRepository } from "@qianliu/database";
import { WecomAppClient, type EndpointConfig } from "../runtime-assurance/wecom-client.js";
import {
  formatDateRange,
  formatModelName,
  formatNumber,
  formatPercentage,
  formatTokenVolume,
} from "./format-utils.js";
import { renderSvgToPng } from "./render-png.js";
import {
  generateIncentiveTop1Svg,
  type IncentiveTop1ReportData,
} from "./templates/incentive-top1-svg.js";
import {
  generateIncentiveOver50Svg,
  type IncentiveOver50ReportData,
} from "./templates/incentive-over50-svg.js";
import {
  MemoryMilestoneStore,
  RedisMilestoneStore,
  type MilestoneStore,
  type RedisClientType,
} from "./milestone-store.js";
import { queryTopModelsForRange } from "./report-jobs.js";
import { pickTop1IncentiveQuote } from "./quote-library.js";

export interface IncentiveCheckOptions {
  db: Kysely<Database>;
  kekBase64: string;
  enterpriseId: string;
  milestoneStore?: MilestoneStore;
  redisClient?: RedisClientType;
  now?: Date;
  dryRun?: boolean;
  force?: boolean;
}

export interface IncentiveCheckResult {
  enterpriseId: string;
  top1Result?: {
    triggered: boolean;
    reason?: string;
    winnerName?: string;
    tokens?: number;
    mediaId?: string;
    svg?: string;
  };
  over50Results?: Array<{
    triggered: boolean;
    reason?: string;
    userName: string;
    tokens: number;
    mediaId?: string;
    svg?: string;
  }>;
}

/**
 * 格式化 ISO 周数字符串，如 "2026-W37"
 */
function getIsoWeekString(date: Date): string {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
}

/**
 * 场景三(a)：登顶第一名流动红旗判定与下发
 */
export async function checkAndDispatchTop1Milestone(
  options: IncentiveCheckOptions,
): Promise<IncentiveCheckResult["top1Result"]> {
  const { db, kekBase64, enterpriseId, dryRun = false } = options;
  const now = options.now ?? new Date();

  // 1. 周一(1)、周二(2)静默期一律不发（可通过 force 强制测试触发）
  const dayOfWeek = now.getDay(); // 0 is Sunday, 1 is Monday, 2 is Tuesday
  if (!options.force && (dayOfWeek === 1 || dayOfWeek === 2)) {
    return { triggered: false, reason: "SILENT_PERIOD_MON_TUE" };
  }

  const store = options.milestoneStore ?? (options.redisClient ? new RedisMilestoneStore(options.redisClient) : new MemoryMilestoneStore());

  const enterprise = await db
    .selectFrom("enterprise")
    .select(["id", "name", "timezone"])
    .where("id", "=", enterpriseId)
    .executeTakeFirst();

  if (!enterprise) {
    return { triggered: false, reason: "ENTERPRISE_NOT_FOUND" };
  }

  const timezone = enterprise.timezone || "Asia/Shanghai";
  const dateStr = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);

  const weekStr = getIsoWeekString(now);

  // 2. 检查当天全团队是否已经发放过流动红旗（每天全团队限发 1 张，可通过 force 强制触发）
  const issuedToday = await store.hasTop1IssuedToday(enterpriseId, dateStr);
  if (issuedToday && !dryRun && !options.force) {
    return { triggered: false, reason: "DAILY_QUOTA_EXHAUSTED" };
  }

  // 3. 计算本周截至当前时刻的用量榜首
  const usageRepo = new UsageOverviewRepository(db, () => now);
  const weekOverview = await usageRepo.getOverview({
    enterpriseId,
    subjectType: "EMPLOYEE",
    period: "WEEK",
    anchor: now,
  });

  const topUser = weekOverview.ranking[0];
  if (!topUser || Number(topUser.realTokens) <= 0) {
    return { triggered: false, reason: "NO_ACTIVE_TOP_USER" };
  }

  const winnerPrincipalId = topUser.subjectId;
  const winnerTokens = Number(topUser.realTokens);

  // 4. 检查该榜首员工本周是否已经领过该卡片（每人每周限领 1 次，可通过 force 强制触发）
  const userAwardedThisWeek = await store.hasUserAwardedTop1ThisWeek(enterpriseId, weekStr, winnerPrincipalId);
  if (userAwardedThisWeek && !dryRun && !options.force) {
    return { triggered: false, reason: "USER_ALREADY_AWARDED_THIS_WEEK" };
  }

  // 5. 命中发放条件：查询企微账号、主力模型并装配卡片数据
  const rangeStart = new Date(weekOverview.range.from);
  const rangeEnd = new Date(weekOverview.range.to);
  const dateRangeStr = formatDateRange(rangeStart, new Date(rangeEnd.getTime() - 1000), timezone);
  const periodLabel = `登顶周榜首 · ${dateRangeStr} (${weekStr.split("-")[1]}周)`;

  const topModels = await queryTopModelsForRange(db, enterpriseId, rangeStart, rangeEnd, winnerPrincipalId, 1);
  const topModelName = topModels[0]?.model ? formatModelName(topModels[0].model) : "多模型深度协同";

  const winCount = await store.getUserTop1WinCount(enterpriseId, winnerPrincipalId);

  const top1Data: IncentiveTop1ReportData = {
    userName: topUser.subjectName,
    periodLabel,
    quote: pickTop1IncentiveQuote(topUser.subjectName, winCount),
    weeklyTokens: formatTokenVolume(winnerTokens),
    teamShare: formatPercentage(topUser.share),
    exceededPercent: "超越全员 99% 同事",
    topModel: topModelName,
  };

  const svg = generateIncentiveTop1Svg(top1Data);

  if (dryRun) {
    return {
      triggered: true,
      winnerName: topUser.subjectName,
      tokens: winnerTokens,
      svg,
    };
  }

  // 查询企微账号
  const identity = await db
    .selectFrom("person_external_identity as pei")
    .innerJoin("principal as pr", "pr.person_id", "pei.person_id")
    .select(["pei.provider_user_id"])
    .where("pr.id", "=", winnerPrincipalId)
    .where("pei.enterprise_id", "=", enterpriseId)
    .where("pei.provider", "=", "WECOM")
    .where("pei.status", "=", "ACTIVE")
    .executeTakeFirst();

  if (!identity?.provider_user_id) {
    return { triggered: false, reason: "NO_WECOM_IDENTITY", winnerName: topUser.subjectName };
  }

  const endpoint = await db
    .selectFrom("notification_endpoint")
    .selectAll()
    .where("provider", "=", "WECOM_APP")
    .where("status", "=", "ACTIVE")
    .executeTakeFirst();

  if (!endpoint) {
    return { triggered: false, reason: "NO_ACTIVE_ENDPOINT" };
  }

  const pngBuffer = renderSvgToPng(svg);
  const client = new WecomAppClient(kekBase64);
  const mediaId = await client.uploadMedia(
    endpoint as EndpointConfig,
    pngBuffer,
    `milestone_top1_${winnerPrincipalId}.png`,
  );

  await client.sendImageMessage(endpoint as EndpointConfig, [identity.provider_user_id], mediaId);

  const textMsg = [
    `🏆 恭喜 ${topUser.subjectName}！您已登顶本周全员 AI 协同榜首！`,
    "━━━━━━━━━━━━━━━━━━",
    `⚡ 本周累计消耗：${formatTokenVolume(winnerTokens)}`,
    `🏅 团队贡献占比：${formatPercentage(topUser.share)}`,
    "━━━━━━━━━━━━━━━━━━",
    "专属流动红旗信笺荣誉已送达上方 👆，领跑全员，继续保持卓越节奏！",
  ].join("\n");

  await client.sendTextMessage(endpoint as EndpointConfig, [identity.provider_user_id], textMsg);

  // 记录频控
  await store.recordTop1IssuedToday(enterpriseId, dateStr);
  await store.recordUserAwardedTop1ThisWeek(enterpriseId, weekStr, winnerPrincipalId);

  return {
    triggered: true,
    winnerName: topUser.subjectName,
    tokens: winnerTokens,
    mediaId,
    svg,
  };
}

/**
 * 场景三(b)：月度超越 50% 员工成长卡判定与下发
 */
export async function checkAndDispatchOver50Milestone(
  options: IncentiveCheckOptions,
): Promise<IncentiveCheckResult["over50Results"]> {
  const { db, kekBase64, enterpriseId, dryRun = false } = options;
  const now = options.now ?? new Date();

  const store = options.milestoneStore ?? (options.redisClient ? new RedisMilestoneStore(options.redisClient) : new MemoryMilestoneStore());

  const enterprise = await db
    .selectFrom("enterprise")
    .select(["id", "name", "timezone"])
    .where("id", "=", enterpriseId)
    .executeTakeFirst();

  if (!enterprise) {
    return [];
  }

  const timezone = enterprise.timezone || "Asia/Shanghai";
  const monthStr = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
  }).format(now); // e.g. "2026-09"

  const monthNum = parseInt(monthStr.split("-")[1] ?? "9", 10);
  const monthTitle = `${monthNum}月份使用 Token 数量`;

  // 查询当月全员用量
  const usageRepo = new UsageOverviewRepository(db, () => now);
  const monthOverview = await usageRepo.getOverview({
    enterpriseId,
    subjectType: "EMPLOYEE",
    period: "MONTH",
    anchor: now,
  });

  const activeRankings = monthOverview.ranking.filter((r) => Number(r.realTokens) > 0);
  if (activeRankings.length < 2) {
    return []; // 人数过少，中位数无激励意义
  }

  // 计算中位数 (Median)
  const tokenList = activeRankings.map((r) => Number(r.realTokens)).sort((a, b) => a - b);
  const mid = Math.floor(tokenList.length / 2);
  const medianTokens: number = tokenList.length % 2 === 0
    ? ((tokenList[mid - 1] ?? 0) + (tokenList[mid] ?? 0)) / 2
    : (tokenList[mid] ?? 0);

  if (!Number.isFinite(medianTokens) || medianTokens <= 0) {
    return [];
  }

  const rangeStart = new Date(monthOverview.range.from);
  const rangeEnd = new Date(monthOverview.range.to);

  const endpoint = dryRun
    ? null
    : await db
        .selectFrom("notification_endpoint")
        .selectAll()
        .where("provider", "=", "WECOM_APP")
        .where("status", "=", "ACTIVE")
        .executeTakeFirst();

  const client = dryRun ? null : new WecomAppClient(kekBase64);
  const results: NonNullable<IncentiveCheckResult["over50Results"]> = [];

  for (const item of activeRankings) {
    const userTokens = Number(item.realTokens);
    if (userTokens <= medianTokens) {
      continue; // 未超过中位数
    }

    const principalId = item.subjectId;
    const alreadyAwarded = await store.hasUserAwardedOver50ThisMonth(enterpriseId, monthStr, principalId);
    if (alreadyAwarded && !dryRun && !options.force) {
      continue; // 本月已领过（可通过 force 强制触发）
    }

    // 查询该员工企微身份
    const identity = await db
      .selectFrom("person_external_identity as pei")
      .innerJoin("principal as pr", "pr.person_id", "pei.person_id")
      .select(["pei.provider_user_id"])
      .where("pr.id", "=", principalId)
      .where("pei.enterprise_id", "=", enterpriseId)
      .where("pei.provider", "=", "WECOM")
      .where("pei.status", "=", "ACTIVE")
      .executeTakeFirst();

    // 查询该员工当月主力模型
    const userModels = await queryTopModelsForRange(db, enterpriseId, rangeStart, rangeEnd, principalId, 2);
    const topModelStr = userModels.length > 0
      ? userModels.map((m) => formatModelName(m.model)).join(" + ")
      : "多模型深度协同";

    const cardData: IncentiveOver50ReportData = {
      userName: item.subjectName,
      monthTitle,
      quote: "已经超过了 50% 的同事",
      performanceText: "领跑半数成员",
      performanceSub: "位列团队前 50%",
      monthlyTokens: formatTokenVolume(userTokens),
      totalRequests: `${formatNumber(item.requestCount)} 次`,
      topModel: topModelStr,
    };

    const svg = generateIncentiveOver50Svg(cardData);

    if (dryRun) {
      results.push({
        triggered: true,
        userName: item.subjectName,
        tokens: userTokens,
        svg,
      });
      continue;
    }

    if (!identity?.provider_user_id || !endpoint || !client) {
      results.push({
        triggered: false,
        reason: !identity ? "NO_WECOM_IDENTITY" : "NO_ACTIVE_ENDPOINT",
        userName: item.subjectName,
        tokens: userTokens,
      });
      continue;
    }

    const pngBuffer = renderSvgToPng(svg);
    const mediaId = await client.uploadMedia(
      endpoint as EndpointConfig,
      pngBuffer,
      `milestone_over50_${principalId}.png`,
    );

    await client.sendImageMessage(endpoint as EndpointConfig, [identity.provider_user_id], mediaId);

    const textMsg = [
      `🎉 恭喜 ${item.subjectName}！您本月的 Token 消耗已经超过了 50% 的同事！`,
      "━━━━━━━━━━━━━━━━━━",
      `⚡ 月累计消耗：${formatTokenVolume(userTokens)}`,
      `📈 累计调用量：${formatNumber(item.requestCount)} 次`,
      "━━━━━━━━━━━━━━━━━━",
      "专属进阶成长信笺已送达上方 👆，快来看看吧！",
    ].join("\n");

    await client.sendTextMessage(endpoint as EndpointConfig, [identity.provider_user_id], textMsg);

    await store.recordUserAwardedOver50ThisMonth(enterpriseId, monthStr, principalId);

    results.push({
      triggered: true,
      userName: item.subjectName,
      tokens: userTokens,
      mediaId,
      svg,
    });
  }

  return results;
}

/**
 * 激励巡检总任务入口（支持周中流动红旗与月度成长卡综合巡检）
 */
export async function runIncentiveChecks(options: IncentiveCheckOptions): Promise<IncentiveCheckResult> {
  const top1Result = await checkAndDispatchTop1Milestone(options);
  const over50Results = await checkAndDispatchOver50Milestone(options);

  return {
    enterpriseId: options.enterpriseId,
    top1Result,
    over50Results,
  };
}
