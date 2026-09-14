import { sql, type Kysely } from "kysely";
import type { Database } from "@qianliu/database";
import { UsageOverviewRepository } from "@qianliu/database";
import { Resvg } from "@resvg/resvg-js";
import { renderSvgToPng as renderSharedSvgToPng } from "./render-png.js";
import { WecomAppClient, type EndpointConfig } from "../runtime-assurance/wecom-client.js";
import { resolveWecomRecipients } from "./report-jobs.js";

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
  }>;
  topModels: Array<{
    model: string;
    tokens: number;
    requestCount: number;
  }>;
}

function formatNumber(num: number | string | bigint): string {
  const n = typeof num === "bigint" ? Number(num) : typeof num === "string" ? Number(num) : num;
  if (!Number.isFinite(n)) return "0";
  return n.toLocaleString("zh-CN");
}

function escapeXml(unsafe: string): string {
  return unsafe
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * 生成现代化深色科技感数据看板 SVG
 */
export function generateDailyReportSvg(data: DailyReportData): string {
  const width = 800;
  const topUsersCount = Math.max(1, data.topUsers.length);
  const rankingHeight = 85 + topUsersCount * 44;
  const modelsCount = Math.max(1, data.topModels.length);
  const modelsHeight = 60 + modelsCount * 36;
  const height = 300 + rankingHeight + modelsHeight + 80;

  const maxUserTokens = Math.max(1, ...data.topUsers.map((u) => u.tokens));

  const userRowsSvg = data.topUsers
    .map((u, i) => {
      const y = 80 + i * 44;
      const barWidth = Math.max(4, Math.round((u.tokens / maxUserTokens) * 200));
      let badgeColor = "#475569";
      let badgeText = "#cbd5e1";
      if (u.rank === 1) {
        badgeColor = "#f59e0b";
        badgeText = "#ffffff";
      } else if (u.rank === 2) {
        badgeColor = "#94a3b8";
        badgeText = "#ffffff";
      } else if (u.rank === 3) {
        badgeColor = "#d97706";
        badgeText = "#ffffff";
      }

      return `
      <g transform="translate(0, ${y})">
        <circle cx="20" cy="16" r="12" fill="${badgeColor}" />
        <text x="20" y="20" font-size="11" font-weight="bold" fill="${badgeText}" text-anchor="middle">${u.rank}</text>
        <text x="44" y="20" font-size="13" font-weight="500" fill="#f8fafc">${escapeXml(u.name)}</text>
        <text x="180" y="20" font-size="12" fill="#94a3b8">${escapeXml(u.department || "-")}</text>
        
        <!-- Progress bar background -->
        <rect x="320" y="10" width="200" height="12" rx="6" fill="#334155" />
        <!-- Progress bar fill -->
        <rect x="320" y="10" width="${barWidth}" height="12" rx="6" fill="url(#barGrad)" />
        
        <text x="540" y="20" font-size="13" font-weight="600" fill="#38bdf8" text-anchor="start">${formatNumber(u.tokens)}</text>
        <text x="700" y="20" font-size="12" fill="#94a3b8" text-anchor="end">${escapeXml(u.share)}</text>
      </g>
    `;
    })
    .join("");

  const modelRowsSvg = data.topModels
    .map((m, i) => {
      const y = 46 + i * 36;
      return `
      <g transform="translate(0, ${y})">
        <rect x="10" y="4" width="8" height="18" rx="2" fill="#6366f1" />
        <text x="26" y="18" font-size="13" font-weight="500" fill="#f1f5f9">${escapeXml(m.model)}</text>
        <text x="450" y="18" font-size="13" font-weight="600" fill="#38bdf8">${formatNumber(m.tokens)} tokens</text>
        <text x="700" y="18" font-size="12" fill="#94a3b8" text-anchor="end">${formatNumber(m.requestCount)} 次请求</text>
      </g>
    `;
    })
    .join("");

  return `
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">
    <defs>
      <linearGradient id="bgGrad" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="#0f172a" />
        <stop offset="100%" stop-color="#1e293b" />
      </linearGradient>
      <linearGradient id="cardGrad" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="#1e293b" />
        <stop offset="100%" stop-color="#0f172a" />
      </linearGradient>
      <linearGradient id="barGrad" x1="0%" y1="0%" x2="100%" y2="0%">
        <stop offset="0%" stop-color="#38bdf8" />
        <stop offset="100%" stop-color="#6366f1" />
      </linearGradient>
      <linearGradient id="accentLine" x1="0%" y1="0%" x2="100%" y2="0%">
        <stop offset="0%" stop-color="#38bdf8" />
        <stop offset="50%" stop-color="#818cf8" />
        <stop offset="100%" stop-color="#c084fc" />
      </linearGradient>
    </defs>

    <!-- Background -->
    <rect width="${width}" height="${height}" fill="url(#bgGrad)" />

    <!-- Top Accent Banner Line -->
    <rect x="0" y="0" width="${width}" height="6" fill="url(#accentLine)" />

    <!-- Header -->
    <g transform="translate(40, 36)" font-family="system-ui, -apple-system, sans-serif">
      <!-- Analytics Icon -->
      <g transform="translate(0, 4)">
        <rect x="0" y="8" width="5" height="14" rx="2" fill="#38bdf8" />
        <rect x="8" y="2" width="5" height="20" rx="2" fill="#818cf8" />
        <rect x="16" y="0" width="5" height="22" rx="2" fill="#c084fc" />
      </g>
      <text x="32" y="20" font-size="22" font-weight="bold" fill="#ffffff" letter-spacing="0.5">仟流智算 · 全员 Token 消费日报</text>
      <text x="0" y="52" font-size="13" fill="#94a3b8">企业：${escapeXml(data.enterpriseName)}  |  日期：${escapeXml(data.reportDate)} (全天数据)</text>
      <text x="720" y="52" font-size="12" fill="#64748b" text-anchor="end">生成时间：${escapeXml(data.generatedAt)}</text>
    </g>

    <!-- 4 KPI Cards Grid -->
    <g transform="translate(40, 115)" font-family="system-ui, -apple-system, sans-serif">
      <!-- Card 1: Total Tokens -->
      <rect x="0" y="0" width="168" height="88" rx="8" fill="url(#cardGrad)" stroke="#334155" stroke-width="1" />
      <text x="16" y="26" font-size="12" fill="#94a3b8">昨日全员总消耗</text>
      <text x="16" y="56" font-size="20" font-weight="bold" fill="#38bdf8">${formatNumber(data.totalTokens)}</text>
      <text x="16" y="74" font-size="10" fill="#64748b">Tokens</text>

      <!-- Card 2: Input / Output -->
      <rect x="184" y="0" width="168" height="88" rx="8" fill="url(#cardGrad)" stroke="#334155" stroke-width="1" />
      <text x="200" y="26" font-size="12" fill="#94a3b8">输入 / 输出 Tokens</text>
      <text x="200" y="52" font-size="14" font-weight="600" fill="#f8fafc">入: ${formatNumber(data.inputTokens)}</text>
      <text x="200" y="72" font-size="14" font-weight="600" fill="#f8fafc">出: ${formatNumber(data.outputTokens)}</text>

      <!-- Card 3: Requests -->
      <rect x="368" y="0" width="168" height="88" rx="8" fill="url(#cardGrad)" stroke="#334155" stroke-width="1" />
      <text x="384" y="26" font-size="12" fill="#94a3b8">请求总调用量</text>
      <text x="384" y="56" font-size="20" font-weight="bold" fill="#10b981">${formatNumber(data.requestCount)}</text>
      <text x="384" y="74" font-size="10" fill="#64748b">次 Gateway 调用</text>

      <!-- Card 4: Active Employees -->
      <rect x="552" y="0" width="168" height="88" rx="8" fill="url(#cardGrad)" stroke="#334155" stroke-width="1" />
      <text x="568" y="26" font-size="12" fill="#94a3b8">活跃 AI 员工数</text>
      <text x="568" y="56" font-size="20" font-weight="bold" fill="#a855f7">${data.activeEmployees}</text>
      <text x="568" y="74" font-size="10" fill="#64748b">人</text>
    </g>

    <!-- Leaderboard Section -->
    <g transform="translate(40, 225)" font-family="system-ui, -apple-system, sans-serif">
      <rect x="0" y="0" width="720" height="${rankingHeight}" rx="10" fill="url(#cardGrad)" stroke="#334155" stroke-width="1" />
      <!-- Trophy Icon -->
      <g transform="translate(18, 14)">
        <path d="M4 2h10v3c0 2.8-2.2 5-5 5s-5-2.2-5-5V2zm-3 2h3v2c0 1.7 1.3 3 3 3H5a4 4 0 0 1-4-4V4zm17 0v1a4 4 0 0 1-4 4h-2c1.7 0 3-1.3 3-3V4h3zm-8 8v3H8v2h6v-2h-3v-3h-2z" fill="#f59e0b"/>
      </g>
      <text x="44" y="28" font-size="15" font-weight="bold" fill="#f8fafc">员工用量消耗排行榜 Top ${data.topUsers.length}</text>
      
      <!-- Table Headers -->
      <text x="44" y="58" font-size="12" fill="#64748b">成员</text>
      <text x="180" y="58" font-size="12" fill="#64748b">部门</text>
      <text x="320" y="58" font-size="12" fill="#64748b">消耗进度</text>
      <text x="540" y="58" font-size="12" fill="#64748b">消耗 Tokens</text>
      <text x="700" y="58" font-size="12" fill="#64748b" text-anchor="end">占比</text>
      <line x1="16" y1="68" x2="704" y2="68" stroke="#334155" stroke-width="1" />

      ${userRowsSvg}
    </g>

    <!-- Model Distribution Section -->
    <g transform="translate(40, ${225 + rankingHeight + 20})" font-family="system-ui, -apple-system, sans-serif">
      <rect x="0" y="0" width="720" height="${modelsHeight}" rx="10" fill="url(#cardGrad)" stroke="#334155" stroke-width="1" />
      <!-- Chip / AI Icon -->
      <g transform="translate(18, 15)">
        <rect x="3" y="3" width="12" height="12" rx="2" fill="#818cf8" />
        <rect x="5" y="5" width="8" height="8" rx="1" fill="#1e1b4b" />
        <path d="M6 0v2M12 0v2M6 16v2M12 16v2M0 6h2M0 12h2M16 6h2M16 12h2" stroke="#818cf8" stroke-width="1.5" stroke-linecap="round"/>
      </g>
      <text x="44" y="28" font-size="15" font-weight="bold" fill="#f8fafc">主要模型消耗分布</text>
      <line x1="16" y1="40" x2="704" y2="40" stroke="#334155" stroke-width="1" />

      ${modelRowsSvg}
    </g>

    <!-- Footer -->
    <g transform="translate(40, ${height - 35})">
      <line x1="0" y1="0" x2="720" y2="0" stroke="#334155" stroke-width="1" />
      <text x="0" y="20" font-size="11" fill="#64748b">仟流智算 (Qianliu AI Gateway) · 企业级大模型网关与用量治理平台</text>
      <text x="720" y="20" font-size="11" fill="#64748b" text-anchor="end">对企微窗口回复「查今天token」可随时自查</text>
    </g>
  </svg>
  `;
}

/**
 * 转换 SVG 为高清 PNG 图像 Buffer
 */
export function renderSvgToPng(svgString: string): Buffer {
  return renderSharedSvgToPng(svgString, { fitWidth: 800 });
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
    tokens: Number(r.realTokens),
    share: r.share,
  }));

  // 3. 统计模型分布 (昨天时间段)
  const rangeFrom = new Date(overview.range.from);
  const rangeTo = new Date(overview.range.to);

  const modelRows = await db
    .selectFrom("ai_request as r")
    .innerJoin("usage_event as u", "u.ai_request_id", "r.id")
    .select([
      "r.unified_model",
      sql<string>`coalesce(sum(u.input_tokens + u.output_tokens), 0)`.as("total_tokens"),
      sql<string>`count(r.id)`.as("req_count"),
    ])
    .where("r.enterprise_id", "=", enterpriseId)
    .where("r.status", "=", "SUCCEEDED")
    .where("r.started_at", ">=", rangeFrom)
    .where("r.started_at", "<", rangeTo)
    .groupBy("r.unified_model")
    .orderBy(sql`sum(u.input_tokens + u.output_tokens)`, "desc")
    .limit(5)
    .execute();

  const topModels = modelRows.map((m) => ({
    model: m.unified_model,
    tokens: Number(m.total_tokens),
    requestCount: Number(m.req_count),
  }));

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

  // 4. 生成 SVG 并渲染为 PNG 图片
  const svg = generateDailyReportSvg(reportData);
  const pngBuffer = renderSvgToPng(svg);

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
    `⚡ 昨日总消耗：${formatNumber(totalTokens)} Tokens`,
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
