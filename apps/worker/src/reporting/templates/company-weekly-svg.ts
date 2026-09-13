import { escapeXml } from "../format-utils.js";
import { QIANLIU_LOGO_DATA_URI } from "./logo-base64.js";

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
  dateRange: string;      // e.g. "9.7 - 9.13 (第37周)"
  totalRequests: string;  // e.g. "10,450"
  totalTokens: string;    // e.g. "384.3"
  dailyAvgTokens: string; // e.g. "54.9"
  totalEmployees?: number; // e.g. 7
  topUsers: CompanyWeeklyUserRow[];
  topModels: CompanyWeeklyModelRow[];
}

/**
 * 场景二：团队全员用量周报（管理看板）
 * 严格对齐用户确认定稿版（附件1 / media_1789225592006.png）：
 * - 画布 540x800，冷灰背景 #EEF2F6；
 * - 浮动白卡 460x700 px (x=40, y=50, rx=18)；
 * - 顶栏：全员用量周报小结 + 9.7 - 9.13 (第37周)；
 * - 3 大数字水平排列，数值纯黑 14px 加粗，单位采用浅灰独立后缀；
 * - 全员使用量表格：前3名采用金、银、铜浅色圆圈徽章，第4~7名采用淡灰纯数字，展示 7 列；
 * - 使用模型表格：模型名加粗，展示 7天消耗、日均消耗、请求数、占比；
 * - 品牌底栏与官方 Logo 完美定位于底部。
 */
export function generateCompanyWeeklySvg(data: CompanyWeeklyReportData): string {
  const totalEmpCount = data.totalEmployees ?? data.topUsers.length;

  // 1. 全员使用量 7 行表格渲染 (y start=276, step=23)
  const userRowsSvg = data.topUsers.slice(0, 7).map((u, i) => {
    const y = 276 + i * 23;

    // 排名徽章：前 3 名采用圆圈徽章，4 名及以后直接显示数字
    let rankBadgeSvg = "";
    if (u.rank === 1) {
      rankBadgeSvg = `
        <circle cx="95" cy="${y - 4}" r="7.5" fill="#FEF3C7" />
        <text x="95" y="${y}" font-size="9.5" font-weight="700" fill="#D97706" text-anchor="middle">1</text>
      `;
    } else if (u.rank === 2) {
      rankBadgeSvg = `
        <circle cx="95" cy="${y - 4}" r="7.5" fill="#E2E8F0" />
        <text x="95" y="${y}" font-size="9.5" font-weight="700" fill="#64748B" text-anchor="middle">2</text>
      `;
    } else if (u.rank === 3) {
      rankBadgeSvg = `
        <circle cx="95" cy="${y - 4}" r="7.5" fill="#FFEDD5" />
        <text x="95" y="${y}" font-size="9.5" font-weight="700" fill="#EA580C" text-anchor="middle">3</text>
      `;
    } else {
      rankBadgeSvg = `
        <text x="95" y="${y}" font-size="10" font-weight="500" fill="#94A3B8" text-anchor="middle">${u.rank}</text>
      `;
    }

    const reqClean = u.requests.replace(/\s*次$/, "");
    const tokensClean = u.tokens.replace(/\s*万$/, "").replace(/\s*亿$/, "");
    const tokensUnit = u.tokens.includes("亿") ? "亿" : "万";
    const dailyClean = u.dailyTokens.replace(/\s*万\s*\/天$/, "").replace(/\s*亿\s*\/天$/, "");
    const dailyUnit = u.dailyTokens.includes("亿") ? "亿 /天" : "万 /天";

    return `
      <!-- Row ${i + 1}: ${escapeXml(u.name)} -->
      ${rankBadgeSvg}
      <text x="113" y="${y}" font-size="10.5" font-weight="700" fill="#172033">${escapeXml(u.name)}</text>
      <text x="148" y="${y}" font-size="10" font-weight="500" fill="#7D8FA4">${escapeXml(u.department || "-")}</text>
      <text x="242" y="${y}" font-size="10.5" font-weight="600" fill="#172033" text-anchor="end">${escapeXml(reqClean)} <tspan font-size="9.5" font-weight="500" fill="#7D8FA4">次</tspan></text>
      <text x="306" y="${y}" font-size="10.5" font-weight="600" fill="#172033" text-anchor="end">${escapeXml(tokensClean)} <tspan font-size="9.5" font-weight="500" fill="#7D8FA4">${tokensUnit}</tspan></text>
      <text x="388" y="${y}" font-size="10.5" font-weight="600" fill="#172033" text-anchor="end">${escapeXml(dailyClean)} <tspan font-size="9.5" font-weight="500" fill="#7D8FA4">${dailyUnit}</tspan></text>
      <text x="453" y="${y}" font-size="10" font-weight="500" fill="#7D8FA4" text-anchor="end">${escapeXml(u.share)}</text>
    `;
  }).join("\n");

  // 2. 使用模型 3 行表格渲染 (y start=514, step=23)
  const modelRowsSvg = data.topModels.slice(0, 3).map((m, i) => {
    const y = 514 + i * 23;
    const mTokensClean = m.tokens.replace(/\s*万$/, "").replace(/\s*亿$/, "");
    const mTokensUnit = m.tokens.includes("亿") ? "亿" : "万";
    const mDailyClean = m.dailyTokens.replace(/\s*万\s*\/天$/, "").replace(/\s*亿\s*\/天$/, "");
    const mDailyUnit = m.dailyTokens.includes("亿") ? "亿 /天" : "万 /天";
    const mReqClean = m.requests.replace(/\s*次$/, "");

    return `
      <!-- Model Row ${i + 1}: ${escapeXml(m.model)} -->
      <text x="87" y="${y}" font-size="10.5" font-weight="700" fill="#172033">${escapeXml(m.model)}</text>
      <text x="229" y="${y}" font-size="10.5" font-weight="600" fill="#172033" text-anchor="end">${escapeXml(mTokensClean)} <tspan font-size="9.5" font-weight="500" fill="#7D8FA4">${mTokensUnit}</tspan></text>
      <text x="312" y="${y}" font-size="10.5" font-weight="600" fill="#172033" text-anchor="end">${escapeXml(mDailyClean)} <tspan font-size="9.5" font-weight="500" fill="#7D8FA4">${mDailyUnit}</tspan></text>
      <text x="388" y="${y}" font-size="10.5" font-weight="600" fill="#172033" text-anchor="end">${escapeXml(mReqClean)} <tspan font-size="9.5" font-weight="500" fill="#7D8FA4">次</tspan></text>
      <text x="453" y="${y}" font-size="10" font-weight="500" fill="#7D8FA4" text-anchor="end">${escapeXml(m.share)}</text>
    `;
  }).join("\n");

  // 去除可能的纯数字外挂
  const totalReqClean = data.totalRequests.replace(/\s*次$/, "");
  const totalTokensClean = data.totalTokens.replace(/\s*万$/, "").replace(/\s*亿$/, "");
  const totalTokensUnit = data.totalTokens.includes("亿") ? "亿" : "万";
  const dailyTokensClean = data.dailyAvgTokens.replace(/\s*万\s*\/天$/, "").replace(/\s*亿\s*\/天$/, "");
  const dailyTokensUnit = data.dailyAvgTokens.includes("亿") ? "亿 /天" : "万 /天";

  return `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="44 60 452 680" width="540" height="812">
  <!-- Pure White Background (Margins reduced by 50%) -->
  <rect x="44" y="60" width="452" height="680" fill="#FFFFFF"/>

  <g font-family="-apple-system, BlinkMacSystemFont, 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'WenQuanYi Zen Hei', 'Noto Sans CJK SC', sans-serif">
    <!-- Header: 全员用量周报小结 + 9.7 - 9.13 (第37周) -->
    <text x="87" y="125" font-size="20" font-weight="700" fill="#172033">全员用量周报小结<tspan dx="12" font-size="12" font-weight="600" fill="#417EE0">${escapeXml(data.dateRange)}</tspan></text>

    <!-- 3 Big Numbers Section -->
    <!-- Column 1: 全周总请求次数 -->
    <g transform="translate(87, 156)">
      <text x="0" y="0" font-size="10.5" font-weight="500" fill="#7D8FA4">全周总请求次数</text>
      <text x="0" y="24" font-size="14" font-weight="700" fill="#172033">${escapeXml(totalReqClean)} <tspan font-size="11" font-weight="500" fill="#7D8FA4">次</tspan></text>
    </g>

    <!-- Column 2: 全周 Token 消耗总量 -->
    <g transform="translate(210, 156)">
      <text x="0" y="0" font-size="10.5" font-weight="500" fill="#7D8FA4">全周 Token 消耗总量</text>
      <text x="0" y="24" font-size="14" font-weight="700" fill="#172033">${escapeXml(totalTokensClean)} <tspan font-size="11" font-weight="500" fill="#7D8FA4">${totalTokensUnit}</tspan></text>
    </g>

    <!-- Column 3: 团队日均使用量 -->
    <g transform="translate(340, 156)">
      <text x="0" y="0" font-size="10.5" font-weight="500" fill="#7D8FA4">团队日均使用量</text>
      <text x="0" y="24" font-size="14" font-weight="700" fill="#172033">${escapeXml(dailyTokensClean)} <tspan font-size="11" font-weight="500" fill="#7D8FA4">${dailyTokensUnit}</tspan></text>
    </g>

    <line x1="87" y1="206" x2="453" y2="206" stroke="#F1F5F9" stroke-width="1" />

    <!-- Section: 全员使用量 -->
    <text x="87" y="234" font-size="13" font-weight="700" fill="#172033">全员使用量</text>
    <text x="453" y="234" font-size="10" font-weight="500" fill="#7D8FA4" text-anchor="end">全员 ${totalEmpCount} 人</text>

    <!-- Table Columns Header -->
    <text x="95" y="254" font-size="10" font-weight="500" fill="#7D8FA4" text-anchor="middle">排名</text>
    <text x="113" y="254" font-size="10" font-weight="500" fill="#7D8FA4">成员</text>
    <text x="148" y="254" font-size="10" font-weight="500" fill="#7D8FA4">所属团队</text>
    <text x="242" y="254" font-size="10" font-weight="500" fill="#7D8FA4" text-anchor="end">请求数</text>
    <text x="306" y="254" font-size="10" font-weight="500" fill="#7D8FA4" text-anchor="end">7天总消耗</text>
    <text x="388" y="254" font-size="10" font-weight="500" fill="#7D8FA4" text-anchor="end">日均使用量</text>
    <text x="453" y="254" font-size="10" font-weight="500" fill="#7D8FA4" text-anchor="end">占比</text>

    <!-- Table Rows -->
    ${userRowsSvg}

    <line x1="87" y1="444" x2="453" y2="444" stroke="#F1F5F9" stroke-width="1" />

    <!-- Section: 使用模型 -->
    <text x="87" y="472" font-size="13" font-weight="700" fill="#172033">使用模型</text>
    <text x="453" y="472" font-size="10" font-weight="500" fill="#7D8FA4" text-anchor="end">本周调用 ${data.topModels.length} 个模型</text>

    <!-- Model Table Headers -->
    <text x="87" y="492" font-size="10" font-weight="500" fill="#7D8FA4">模型</text>
    <text x="229" y="492" font-size="10" font-weight="500" fill="#7D8FA4" text-anchor="end">7天消耗</text>
    <text x="312" y="492" font-size="10" font-weight="500" fill="#7D8FA4" text-anchor="end">日均消耗</text>
    <text x="388" y="492" font-size="10" font-weight="500" fill="#7D8FA4" text-anchor="end">请求数</text>
    <text x="453" y="492" font-size="10" font-weight="500" fill="#7D8FA4" text-anchor="end">占比</text>

    <!-- Model Table Rows -->
    ${modelRowsSvg}

    <line x1="87" y1="586" x2="453" y2="586" stroke="#F1F5F9" stroke-width="1" />

    <!-- Brand Footer -->
    <text x="87" y="636" font-size="15" font-weight="700" fill="#172033">仟流智算</text>
    <text x="87" y="654" font-size="11" font-weight="500" fill="#7D8FA4" letter-spacing="0.8">Qianliu IC</text>

    <!-- Official Logo: 50x50, Right Edge X=453, Bottom Edge Y=654 -->
    <image href="${QIANLIU_LOGO_DATA_URI}" x="401" y="606" width="52" height="52"/>
  </g>
</svg>
`.trim();
}
