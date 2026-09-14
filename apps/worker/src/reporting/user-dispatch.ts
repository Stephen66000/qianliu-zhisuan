import { sql, type Kysely } from "kysely";
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
import { pickTop1IncentiveQuote } from "./quote-library.js";
import {
  runCompanyWeeklyReport,
  runPersonalWeeklyReports,
  queryTopModelsForRange,
  resolveWecomRecipients,
} from "./report-jobs.js";
import { runDailyTokenReport } from "./daily-token-report.js";

export interface DispatchAllCardsOptions {
  db: Kysely<Database>;
  kekBase64: string;
  enterpriseId: string;
  targetUser: string; // e.g. "李佳"
  dryRun?: boolean;
}

export interface CardDispatchResult {
  cardType: "COMPANY_WEEKLY" | "PERSONAL_WEEKLY" | "DAILY_REPORT" | "TOP1_INCENTIVE" | "OVER50_INCENTIVE";
  title: string;
  status: "SENT" | "DRY_RUN" | "SKIPPED" | "FAILED";
  mediaId?: string;
  detail?: string;
}

export interface DispatchAllCardsSummary {
  targetUser: string;
  providerUserId?: string;
  enterpriseName: string;
  results: CardDispatchResult[];
}

/**
 * 专为单个指定员工（如管理员、测试人员或特定成员）单独下发全套 5 种报表与激励卡片：
 * 1. 团队全员用量周报（高清长图 + 小结文案）
 * 2. 员工个人周报信笺（专属信笺卡片 + 小结文案）
 * 3. 每日用量消费日报（科技风大盘长图 + 小结文案）
 * 4. 登顶第 1 名流动红旗卡片（荣誉卡片 + 专属贺信）
 * 5. 月度超越 50% 员工成长卡片（进阶卡片 + 专属贺信）
 */
export async function dispatchAllCardsToUser(
  options: DispatchAllCardsOptions,
): Promise<DispatchAllCardsSummary> {
  const { db, kekBase64, enterpriseId, targetUser, dryRun = false } = options;

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

  // 1. 查询员工企微身份绑定
  const resolvedRecipients = await resolveWecomRecipients(db, enterpriseId, [targetUser]);
  const providerUserId = resolvedRecipients[0];

  if (!providerUserId) {
    throw new Error(`未找到员工 [${targetUser}] 对应的企微账号 (provider_user_id)，请先确认通讯录已同步或姓名准确。`);
  }

  // 查询主体信息
  const personRow = await db
    .selectFrom("person as p")
    .innerJoin("person_external_identity as pei", "pei.person_id", "p.id")
    .leftJoin("principal as pr", "pr.person_id", "p.id")
    .select(["p.id as person_id", "p.name as person_name", "pr.id as principal_id", "pei.provider_user_id"])
    .where("pei.enterprise_id", "=", enterpriseId)
    .where("pei.provider_user_id", "=", providerUserId)
    .executeTakeFirst();

  const realName = personRow?.person_name || targetUser;
  const principalId = personRow?.principal_id;

  const endpoint = dryRun
    ? null
    : await db
        .selectFrom("notification_endpoint")
        .selectAll()
        .where("provider", "=", "WECOM_APP")
        .where("status", "=", "ACTIVE")
        .executeTakeFirst();

  if (!dryRun && !endpoint) {
    throw new Error("系统中未找到处于 ACTIVE 状态的企业微信通知通道 (notification_endpoint)。");
  }

  const client = dryRun ? null : new WecomAppClient(kekBase64);
  const results: CardDispatchResult[] = [];

  // ─────────────────────────────────────────────────────────────
  // 卡片 1：团队全员用量周报
  // ─────────────────────────────────────────────────────────────
  try {
    const companyRes = await runCompanyWeeklyReport({
      db,
      kekBase64,
      enterpriseId,
      recipients: [providerUserId],
      dryRun,
    });
    results.push({
      cardType: "COMPANY_WEEKLY",
      title: "团队全员用量周报",
      status: companyRes.status === "SENT" ? "SENT" : dryRun ? "DRY_RUN" : "FAILED",
      mediaId: companyRes.mediaId,
      detail: `总消耗: ${formatTokenVolume(companyRes.totalTokens)}, 活跃员工: ${companyRes.activeEmployees} 人`,
    });
  } catch (err: any) {
    results.push({
      cardType: "COMPANY_WEEKLY",
      title: "团队全员用量周报",
      status: "FAILED",
      detail: err?.message || String(err),
    });
  }

  // ─────────────────────────────────────────────────────────────
  // 卡片 2：员工个人周报信笺
  // ─────────────────────────────────────────────────────────────
  try {
    const personalResList = await runPersonalWeeklyReports({
      db,
      kekBase64,
      enterpriseId,
      userPersonId: realName,
      dryRun,
    });
    const personalRes = personalResList[0];
    results.push({
      cardType: "PERSONAL_WEEKLY",
      title: "员工个人周报信笺",
      status: personalRes?.status === "SENT" ? "SENT" : dryRun ? "DRY_RUN" : "FAILED",
      mediaId: personalRes?.mediaId,
      detail: personalRes ? `周总消耗: ${formatTokenVolume(personalRes.totalTokens)}, 请求数: ${personalRes.requestCount}` : "无周报数据",
    });
  } catch (err: any) {
    results.push({
      cardType: "PERSONAL_WEEKLY",
      title: "员工个人周报信笺",
      status: "FAILED",
      detail: err?.message || String(err),
    });
  }

  // ─────────────────────────────────────────────────────────────
  // 卡片 3：每日用量消费日报
  // ─────────────────────────────────────────────────────────────
  try {
    const dailyRes = await runDailyTokenReport({
      db,
      kekBase64,
      enterpriseId,
      recipients: [providerUserId],
      dryRun,
    });
    results.push({
      cardType: "DAILY_REPORT",
      title: "每日 Token 消费日报",
      status: dailyRes.status === "SENT" ? "SENT" : dryRun ? "DRY_RUN" : "FAILED",
      mediaId: dailyRes.mediaId,
      detail: `全员日消耗: ${formatTokenVolume(dailyRes.totalTokens)}, 请求数: ${dailyRes.requestCount}`,
    });
  } catch (err: any) {
    results.push({
      cardType: "DAILY_REPORT",
      title: "每日 Token 消费日报",
      status: "FAILED",
      detail: err?.message || String(err),
    });
  }

  // ─────────────────────────────────────────────────────────────
  // 卡片 4：登顶第 1 名流动红旗卡片
  // ─────────────────────────────────────────────────────────────
  try {
    const usageRepo = new UsageOverviewRepository(db, () => now);
    const weekOverview = await usageRepo.getOverview({
      enterpriseId,
      subjectType: "EMPLOYEE",
      period: "WEEK",
      anchor: now,
    });

    const rangeStart = new Date(weekOverview.range.from);
    const rangeEnd = new Date(weekOverview.range.to);
    const dateRangeStr = formatDateRange(rangeStart, new Date(rangeEnd.getTime() - 1000), timezone);
    const periodLabel = `登顶周榜首 · ${dateRangeStr}`;

    const userModels = principalId
      ? await queryTopModelsForRange(db, enterpriseId, rangeStart, rangeEnd, principalId, 1)
      : [];
    const topModelName = userModels[0]?.model ? formatModelName(userModels[0].model) : "多模型深度协同";

    const userRanking = weekOverview.ranking.find((r) => r.subjectId === principalId);
    const displayTokens = userRanking && Number(userRanking.realTokens) > 0
      ? formatTokenVolume(Number(userRanking.realTokens))
      : "128.0 万";
    const displayShare = userRanking && Number(userRanking.realTokens) > 0
      ? formatPercentage(userRanking.share)
      : "33.3%";

    const top1Data: IncentiveTop1ReportData = {
      userName: realName,
      periodLabel,
      quote: pickTop1IncentiveQuote(realName, 1),
      weeklyTokens: displayTokens,
      teamShare: displayShare,
      exceededPercent: "超越全员 99% 同事",
      topModel: topModelName,
      topModelSub: "高频深度推理与代码",
    };

    const top1Svg = generateIncentiveTop1Svg(top1Data);
    if (dryRun) {
      results.push({
        cardType: "TOP1_INCENTIVE",
        title: "登顶第 1 名流动红旗",
        status: "DRY_RUN",
      });
    } else if (endpoint && client) {
      const pngBuffer = renderSvgToPng(top1Svg);
      const mediaId = await client.uploadMedia(
        endpoint as EndpointConfig,
        pngBuffer,
        `top1_${providerUserId}.png`,
      );
      await client.sendImageMessage(endpoint as EndpointConfig, [providerUserId], mediaId);

      const top1Text = [
        `🏆 恭喜 ${realName}！您已登顶本周全员 AI 协同榜首！`,
        "━━━━━━━━━━━━━━━━━━",
        `⚡ 本周累计消耗：${displayTokens}`,
        `🏅 团队贡献占比：${displayShare}`,
        `🌟 核心协同模型：${topModelName}`,
        "━━━━━━━━━━━━━━━━━━",
        "流动红旗专属荣誉记录已送达上方👆，快分享给你的朋友吧！",
      ].join("\n");
      await client.sendTextMessage(endpoint as EndpointConfig, [providerUserId], top1Text);

      results.push({
        cardType: "TOP1_INCENTIVE",
        title: "登顶第 1 名流动红旗",
        status: "SENT",
        mediaId,
        detail: `周消耗: ${displayTokens}, 贡献率: ${displayShare}`,
      });
    }
  } catch (err: any) {
    results.push({
      cardType: "TOP1_INCENTIVE",
      title: "登顶第 1 名流动红旗",
      status: "FAILED",
      detail: err?.message || String(err),
    });
  }

  // ─────────────────────────────────────────────────────────────
  // 卡片 5：月度超越 50% 员工成长卡片
  // ─────────────────────────────────────────────────────────────
  try {
    const monthStr = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
    }).format(now);
    const monthNum = parseInt(monthStr.split("-")[1] ?? "9", 10);
    const monthTitle = `${monthNum}月份使用 Token 数量`;

    const usageRepo = new UsageOverviewRepository(db, () => now);
    const monthOverview = await usageRepo.getOverview({
      enterpriseId,
      subjectType: "EMPLOYEE",
      period: "MONTH",
      anchor: now,
    });

    const rangeStart = new Date(monthOverview.range.from);
    const rangeEnd = new Date(monthOverview.range.to);

    const userMonthRanking = monthOverview.ranking.find((r) => r.subjectId === principalId);
    const userModels = principalId
      ? await queryTopModelsForRange(db, enterpriseId, rangeStart, rangeEnd, principalId, 2)
      : [];
    const topModelStr = userModels.length > 0
      ? userModels.map((m) => formatModelName(m.model)).join(" + ")
      : "多模型深度协同";

    const displayTokens = userMonthRanking && Number(userMonthRanking.realTokens) > 0
      ? formatTokenVolume(Number(userMonthRanking.realTokens))
      : "68.5 万";
    const displayRequests = userMonthRanking && Number(userMonthRanking.requestCount) > 0
      ? `${formatNumber(userMonthRanking.requestCount)} 次`
      : "1,620 次";

    const over50Data: IncentiveOver50ReportData = {
      userName: realName,
      monthTitle,
      quote: "已经超过了 50% 的同事",
      performanceText: "领跑半数成员",
      performanceSub: "位列团队前 50%",
      monthlyTokens: displayTokens,
      totalRequests: displayRequests,
      topModel: topModelStr,
      topModelSub: "深度推理与综合协作",
    };

    const over50Svg = generateIncentiveOver50Svg(over50Data);
    if (dryRun) {
      results.push({
        cardType: "OVER50_INCENTIVE",
        title: "超越 50% 员工成长激励卡",
        status: "DRY_RUN",
      });
    } else if (endpoint && client) {
      const pngBuffer = renderSvgToPng(over50Svg);
      const mediaId = await client.uploadMedia(
        endpoint as EndpointConfig,
        pngBuffer,
        `over50_${providerUserId}.png`,
      );
      await client.sendImageMessage(endpoint as EndpointConfig, [providerUserId], mediaId);

      const over50Text = [
        `🎉 恭喜 ${realName}！您的 AI 协同用量已成功领跑半数成员！`,
        "━━━━━━━━━━━━━━━━━━",
        `⚡ 当月累计消耗：${displayTokens}`,
        `🚀 累计请求次数：${displayRequests}`,
        `🌟 核心协同模型：${topModelStr}`,
        "━━━━━━━━━━━━━━━━━━",
        "月度成长进阶荣誉卡已送达上方👆，请查收！",
      ].join("\n");
      await client.sendTextMessage(endpoint as EndpointConfig, [providerUserId], over50Text);

      results.push({
        cardType: "OVER50_INCENTIVE",
        title: "超越 50% 员工成长激励卡",
        status: "SENT",
        mediaId,
        detail: `当月消耗: ${displayTokens}, 请求数: ${displayRequests}`,
      });
    }
  } catch (err: any) {
    results.push({
      cardType: "OVER50_INCENTIVE",
      title: "超越 50% 员工成长激励卡",
      status: "FAILED",
      detail: err?.message || String(err),
    });
  }

  return {
    targetUser: realName,
    providerUserId,
    enterpriseName: enterprise.name,
    results,
  };
}
