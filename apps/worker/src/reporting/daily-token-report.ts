import { type Kysely } from "kysely";
import type { Database } from "@qianliu/database";
import { UsageOverviewRepository } from "@qianliu/database";
import { renderSvgToPng as renderSharedSvgToPng } from "./render-png.js";
import { WecomAppClient, type EndpointConfig } from "../runtime-assurance/wecom-client.js";
import { resolveWecomRecipients, queryTopModelsForRange } from "./report-jobs.js";
import {
  formatNumber,
  formatTokenVolume,
  formatPercentage,
} from "./format-utils.js";
import {
  generateDailyTokenReportSvg,
  type DailyTokenReportData,
  type DailyUserRow,
  type DailyModelRow,
} from "./templates/daily-token-report-svg.js";

export {
  generateDailyTokenReportSvg,
  type DailyTokenReportData,
  type DailyUserRow,
  type DailyModelRow,
};

export interface DailyReportData {
  enterpriseName: string;
  reportDate: string; // YYYY-MM-DD
  generatedAt: string;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheTokens: number;
  requestCount: number;
  activeEmployees: number;
  topUsers: Array<{
    rank: number;
    name: string;
    department: string;
    tokens: number;
    share: string;
    requests?: number;
  }>;
  topModels: Array<{
    model: string;
    tokens: number;
    requestCount: number;
    share?: string;
  }>;
}

/**
 * 生成符合仟流设计规范的纯白优雅竖版数据看板 SVG（540x760）
 */
export function generateDailyReportSvg(data: DailyReportData): string {
  const svgData: DailyTokenReportData = {
    enterpriseName: data.enterpriseName,
    reportDate: data.reportDate.includes("昨日") ? data.reportDate : `${data.reportDate} (昨日全天)`,
    totalRequests: formatNumber(data.requestCount),
    totalTokens: formatTokenVolume(data.totalTokens),
    activeEmployees: data.activeEmployees,
    topUsers: data.topUsers.map((u) => ({
      rank: u.rank,
      name: u.name,
      department: u.department,
      requests: formatNumber(u.requests ?? 0),
      tokens: formatTokenVolume(u.tokens),
      share: formatPercentage(u.share),
    })),
    topModels: data.topModels.map((m) => {
      const shareStr = m.share ?? (data.totalTokens > 0 ? formatPercentage(m.tokens / data.totalTokens) : "0.0%");
      return {
        model: m.model,
        tokens: formatTokenVolume(m.tokens),
        requests: formatNumber(m.requestCount),
        share: shareStr,
      };
    }),
  };
  return generateDailyTokenReportSvg(svgData);
}

/**
 * 转换 SVG 为高清 PNG 图像 Buffer（标准 2x 视网膜清晰度 1080 宽）
 */
export function renderSvgToPng(svgString: string): Promise<Buffer> {
  return renderSharedSvgToPng(svgString, { fitWidth: 1080 });
}

export interface RunDailyReportOptions {
  db: Kysely<Database>;
  kekBase64: string;
  enterpriseId: string;
  targetDate?: Date; // 默认为昨日
  recipients?: string[]; // 企微 userid 列表
  dryRun?: boolean;
}

export interface RunDailyReportResult {
  reportDate: string;
  enterpriseName: string;
  totalTokens: number;
  requestCount: number;
  activeEmployees: number;
  recipients: string[];
  mediaId?: string;
  status: "SENT" | "DRY_RUN" | "NO_RECIPIENTS" | "NO_ACTIVE_ENDPOINT";
}

/**
 * 聚合昨日数据、生成长图并推送给企微指定人
 */
export async function runDailyTokenReport(
  options: RunDailyReportOptions,
): Promise<RunDailyReportResult> {
  const { db, kekBase64, enterpriseId, dryRun = false } = options;
  const now = new Date();
  const targetDate = options.targetDate ?? new Date(now.getTime() - 24 * 3600_000);

  // 1. 获取企业信息
  const enterprise = await db
    .selectFrom("enterprise")
    .select(["id", "name", "timezone"])
    .where("id", "=", enterpriseId)
    .executeTakeFirst();

  if (!enterprise) {
    throw new Error(`Enterprise not found: ${enterpriseId}`);
  }

  const timezone = enterprise.timezone || "Asia/Shanghai";
  const dateStr = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(targetDate);

  // 2. 调用 UsageOverviewRepository 聚合全员昨日用量
  const usageRepo = new UsageOverviewRepository(db, () => targetDate);
  const overview = await usageRepo.getOverview({
    enterpriseId,
    subjectType: "EMPLOYEE",
    period: "TODAY",
    anchor: targetDate,
  });

  const totalTokens = Number(overview.metrics.realTokens);
  const inputTokens = Number(overview.metrics.inputTokens);
  const outputTokens = Number(overview.metrics.outputTokens);
  const cacheTokens = Number(overview.metrics.cacheTokens);
  const requestCount = Number(overview.metrics.requestCount);
  const activeEmployees = overview.metrics.activeSubjects;

  const topUsers = overview.ranking.slice(0, 10).map((r, idx) => ({
    rank: idx + 1,
    name: r.subjectName,
    department: r.departmentLabel ?? "未分配部门",
    requests: Number(r.requestCount || 0),
    tokens: Number(r.realTokens),
    share: formatPercentage(r.share),
  }));

  // 3. 统计模型分布 (昨天时间段，关联官方模型显示名)
  const rangeFrom = new Date(overview.range.from);
  const rangeTo = new Date(overview.range.to);

  const topModelsRaw = await queryTopModelsForRange(db, enterpriseId, rangeFrom, rangeTo, undefined, 3);
  const topModels = topModelsRaw.map((m) => {
    const shareStr = totalTokens > 0 ? formatPercentage(m.tokens / totalTokens) : "0.0%";
    return {
      model: m.model,
      tokens: m.tokens,
      requestCount: m.requestCount,
      share: shareStr,
    };
  });

  const reportData: DailyReportData = {
    enterpriseName: enterprise.name,
    reportDate: dateStr,
    generatedAt: new Intl.DateTimeFormat("zh-CN", {
      timeZone: timezone,
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(now),
    totalTokens,
    inputTokens,
    outputTokens,
    cacheTokens,
    requestCount,
    activeEmployees,
    topUsers,
    topModels,
  };

  // 4. 生成符合仟流设计规范的纯白竖版 SVG 并渲染为 PNG 图片
  const svg = generateDailyReportSvg(reportData);
  const pngBuffer = await renderSvgToPng(svg);

  // 5. 确定接收人列表
  let recipients = options.recipients;
  if (!recipients || recipients.length === 0) {
    const envRecipients = process.env.WECOM_DAILY_REPORT_RECIPIENTS;
    if (envRecipients && envRecipients.trim().length > 0) {
      recipients = envRecipients.split(",").map((s) => s.trim()).filter(Boolean);
    } else {
      // 默认查找所有拥有企业微信身份的管理员
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

  if (recipients && recipients.length > 0) {
    recipients = await resolveWecomRecipients(db, enterpriseId, recipients);
  }

  if (dryRun) {
    return {
      reportDate: dateStr,
      enterpriseName: enterprise.name,
      totalTokens,
      requestCount,
      activeEmployees,
      recipients: recipients ?? [],
      status: "DRY_RUN",
    };
  }

  if (!recipients || recipients.length === 0) {
    return {
      reportDate: dateStr,
      enterpriseName: enterprise.name,
      totalTokens,
      requestCount,
      activeEmployees,
      recipients: [],
      status: "NO_RECIPIENTS",
    };
  }

  // 6. 查询活跃的企业微信 Endpoint
  const endpoint = await db
    .selectFrom("notification_endpoint")
    .selectAll()
    .where("provider", "=", "WECOM_APP")
    .where("status", "=", "ACTIVE")
    .executeTakeFirst();

  if (!endpoint) {
    return {
      reportDate: dateStr,
      enterpriseName: enterprise.name,
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
    `token_daily_report_${dateStr}.png`,
  );

  // 发送图片消息
  await client.sendImageMessage(endpoint as EndpointConfig, recipients, mediaId);

  // 伴随发送核心文字摘要卡片
  const summaryText = [
    `📊 【${enterprise.name}】Token 消费日报 (${dateStr})`,
    "━━━━━━━━━━━━━━━━━━",
    `⚡ 昨日总消耗：${formatTokenVolume(totalTokens)}`,
    `📈 请求调用量：${formatNumber(requestCount)} 次`,
    `👥 活跃员工数：${activeEmployees} 人`,
    "━━━━━━━━━━━━━━━━━━",
    "详见上方高清长图 👆",
  ].join("\n");

  await client.sendTextMessage(endpoint as EndpointConfig, recipients, summaryText);

  return {
    reportDate: dateStr,
    enterpriseName: enterprise.name,
    totalTokens,
    requestCount,
    activeEmployees,
    recipients,
    mediaId,
    status: "SENT",
  };
}
