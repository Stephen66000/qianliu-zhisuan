/* eslint-disable no-console -- CLI 进度输出（2026-09-14 I1 审核登记）：本文件为命令行下发工具，stdout 即用户界面。 */
import { type Kysely } from "kysely";
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
// eslint-disable-next-line complexity -- 已登记例外（2026-09-14 I1 审核）：5 款卡片顺序下发编排，后续按卡片类型提取子任务。
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

  console.log(`[worker] 🔍 正在检索员工 [${targetUser}] 的企微身份绑定...`);

  // 1. 查询员工企微身份绑定
  const personRow = await db
    .selectFrom("person as p")
    .innerJoin("person_external_identity as pei", "pei.person_id", "p.id")
    .leftJoin("principal as pr", "pr.person_id", "p.id")
    .select(["p.id as person_id", "p.name as person_name", "pr.id as principal_id", "pei.provider_user_id"])
    .where("pei.enterprise_id", "=", enterpriseId)
    .where("pei.provider", "=", "WECOM")
    .where("pei.status", "=", "ACTIVE")
    .where((eb) =>
      eb.or([
        eb("p.name", "=", targetUser),
        eb("p.name", "like", `%${targetUser}%`),
        eb("pei.provider_user_id", "=", targetUser),
      ]),
    )
    .executeTakeFirst();

  if (!personRow) {
    const allMembers = await db
      .selectFrom("person as p")
      .innerJoin("person_external_identity as pei", "pei.person_id", "p.id")
      .select(["p.name", "pei.provider_user_id"])
      .where("pei.enterprise_id", "=", enterpriseId)
      .where("pei.provider", "=", "WECOM")
      .execute();
    console.error(`[worker] ❌ 未找到匹配 [${targetUser}] 的企微员工。系统中现有企微成员如下:`);
    allMembers.forEach((m) => console.error(`  - ${m.name} (企微 UserID: ${m.provider_user_id})`));
    throw new Error(`未找到员工 [${targetUser}] 对应的企微账号，请确认姓名是否匹配通讯录。`);
  }

  const realName = personRow.person_name;
  const providerUserId = personRow.provider_user_id;
  const principalId = personRow.principal_id;

  console.log(`[worker] ✅ 成功定位员工: ${realName} (企微 UserID: ${providerUserId})`);

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

  console.log(`[worker] 📡 企业微信通道已连接 (AgentID: ${endpoint?.agent_id ?? "DRY_RUN"})，开始依次生成并下发 5 款卡片...`);
  const client = dryRun ? null : new WecomAppClient(kekBase64);
  const results: CardDispatchResult[] = [];

  // ─────────────────────────────────────────────────────────────
  // 卡片 1：团队全员用量周报
  // ─────────────────────────────────────────────────────────────
  console.log(`[worker] [1/5] 正在生成并推送【团队全员用量周报】...`);
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
    console.log(`[worker] [1/5] ✅ 团队全员用量周报下发完成 (消耗: ${formatTokenVolume(companyRes.totalTokens)})`);
  } catch (err: unknown) {
    console.error(`[worker] [1/5] ❌ 团队全员用量周报下发失败:`, err instanceof Error ? err.message : String(err));
    results.push({
      cardType: "COMPANY_WEEKLY",
      title: "团队全员用量周报",
      status: "FAILED",
      detail: err instanceof Error ? err.message : String(err),
    });
  }

  // ─────────────────────────────────────────────────────────────
  // 卡片 2：员工个人周报信笺
  // ─────────────────────────────────────────────────────────────
  console.log(`[worker] [2/5] 正在生成并推送【员工个人周报信笺】(针对: ${realName})...`);
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
    console.log(`[worker] [2/5] ✅ 员工个人周报信笺下发完成 (周消耗: ${personalRes ? formatTokenVolume(personalRes.totalTokens) : "0"})`);
  } catch (err: unknown) {
    console.error(`[worker] [2/5] ❌ 员工个人周报信笺下发失败:`, err instanceof Error ? err.message : String(err));
    results.push({
      cardType: "PERSONAL_WEEKLY",
      title: "员工个人周报信笺",
      status: "FAILED",
      detail: err instanceof Error ? err.message : String(err),
    });
  }

  // ─────────────────────────────────────────────────────────────
  // 卡片 3：每日用量消费日报
  // ─────────────────────────────────────────────────────────────
  console.log(`[worker] [3/5] 正在生成并推送【每日 Token 消费日报】...`);
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
    console.log(`[worker] [3/5] ✅ 每日 Token 消费日报下发完成 (日消耗: ${formatTokenVolume(dailyRes.totalTokens)})`);
  } catch (err: unknown) {
    console.error(`[worker] [3/5] ❌ 每日 Token 消费日报下发失败:`, err instanceof Error ? err.message : String(err));
    results.push({
      cardType: "DAILY_REPORT",
      title: "每日 Token 消费日报",
      status: "FAILED",
      detail: err instanceof Error ? err.message : String(err),
    });
  }

  // ─────────────────────────────────────────────────────────────
  // 卡片 4：登顶第 1 名流动红旗卡片
  // ─────────────────────────────────────────────────────────────
  console.log(`[worker] [4/5] 正在生成并推送【登顶第 1 名流动红旗】...`);
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
      console.log(`[worker] [4/5] 演练模式：已生成登顶流动红旗卡片`);
    } else if (endpoint && client) {
      const pngBuffer = await renderSvgToPng(top1Svg);
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
      console.log(`[worker] [4/5] ✅ 登顶第 1 名流动红旗荣誉卡下发完成`);
    }
  } catch (err: unknown) {
    console.error(`[worker] [4/5] ❌ 登顶流动红旗荣誉卡下发失败:`, err instanceof Error ? err.message : String(err));
    results.push({
      cardType: "TOP1_INCENTIVE",
      title: "登顶第 1 名流动红旗",
      status: "FAILED",
      detail: err instanceof Error ? err.message : String(err),
    });
  }

  // ─────────────────────────────────────────────────────────────
  // 卡片 5：月度超越 50% 员工成长卡片
  // ─────────────────────────────────────────────────────────────
  console.log(`[worker] [5/5] 正在生成并推送【超越 50% 员工成长激励卡】...`);
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
      console.log(`[worker] [5/5] 演练模式：已生成超越 50% 员工成长激励卡`);
    } else if (endpoint && client) {
      const pngBuffer = await renderSvgToPng(over50Svg);
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
      console.log(`[worker] [5/5] ✅ 超越 50% 员工成长激励卡下发完成`);
    }
  } catch (err: unknown) {
    console.error(`[worker] [5/5] ❌ 超越 50% 员工成长激励卡下发失败:`, err instanceof Error ? err.message : String(err));
    results.push({
      cardType: "OVER50_INCENTIVE",
      title: "超越 50% 员工成长激励卡",
      status: "FAILED",
      detail: err instanceof Error ? err.message : String(err),
    });
  }

  return {
    targetUser: realName,
    providerUserId,
    enterpriseName: enterprise.name,
    results,
  };
}
