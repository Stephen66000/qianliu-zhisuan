import { escapeXml } from "../format-utils.js";
import { QIANLIU_LOGO_DATA_URI } from "./logo-base64.js";

export interface CompanyWeeklyUserRow {
  rank: number;
  name: string;
  department: string;
  requests: string; // e.g. "1,250"
  tokens: string;   // e.g. "128.0 万"
  dailyTokens: string; // e.g. "18.3 万 /天"
  share: string;    // e.g. "33.3%"
}

export interface CompanyWeeklyModelRow {
  model: string;    // e.g. "DeepSeek V3"
  tokens: string;   // e.g. "235.0 万"
  dailyTokens: string; // e.g. "33.6 万 /天"
  requests: string; // e.g. "6,800"
  share: string;    // e.g. "61.2%"
}

export interface CompanyWeeklyReportData {
  enterpriseName: string;
  dateRange: string; // e.g. "9.7 - 9.13"
  totalRequests: string; // e.g. "10,450 次"
  totalTokens: string;   // e.g. "384.3 万"
  dailyAvgTokens: string; // e.g. "54.9 万 /天"
  topUsers: CompanyWeeklyUserRow[];
  topModels: CompanyWeeklyModelRow[];
}

/**
 * 场景二：团队全员用量周报（管理看板）
 * 遵循《仟流智算 · 团队全员用量周报视觉与格式规范 v1.5》：
 * - 画布 540x800，冷灰背景 #EEF2F6；
 * - 浮动白卡 416x658 px，等比缩放 0.8，Safe Area X=62, Y=71；
 * - 两级字号阶梯：3 大数字 14px Bold 全黑，表格数据全量统一 11px Bold；
 * - 日均使用量与日均消耗全面回归沉稳墨黑（#172033）；
 * - 纯矢量图形，杜绝 Emoji。
 */
export function generateCompanyWeeklySvg(data: CompanyWeeklyReportData): string {
  // 1. 全员使用量行 SVG
  const userRowsSvg = data.topUsers.slice(0, 5).map((u, i) => {
    const y = 280 + i * 22;
    return `
      <!-- Row ${i + 1}: ${escapeXml(u.name)} -->
      <text x="94" y="${y}" font-size="11" font-weight="700" fill="#172033">${escapeXml(u.name)} <tspan font-weight="700" fill="#7D8FA4">${escapeXml(u.department || "-")}</tspan></text>
      <text x="210" y="${y}" font-size="11" font-weight="700" fill="#172033" text-anchor="end">${escapeXml(u.requests)}</text>
      <text x="286" y="${y}" font-size="11" font-weight="700" fill="#172033" text-anchor="end">${escapeXml(u.tokens)}</text>
      <text x="382" y="${y}" font-size="11" font-weight="700" fill="#172033" text-anchor="end">${escapeXml(u.dailyTokens)}</text>
      <text x="445" y="${y}" font-size="11" font-weight="500" fill="#7D8FA4" text-anchor="end">${escapeXml(u.share)}</text>
    `;
  }).join("\n");

  // 2. 模型使用行 SVG
  const modelRowsSvg = data.topModels.slice(0, 3).map((m, i) => {
    const y = 442 + i * 22;
    return `
      <!-- Model ${i + 1}: ${escapeXml(m.model)} -->
      <text x="94" y="${y}" font-size="11" font-weight="700" fill="#172033">${escapeXml(m.model)}</text>
      <text x="238" y="${y}" font-size="11" font-weight="700" fill="#172033" text-anchor="end">${escapeXml(m.tokens)}</text>
      <text x="330" y="${y}" font-size="11" font-weight="700" fill="#172033" text-anchor="end">${escapeXml(m.dailyTokens)}</text>
      <text x="396" y="${y}" font-size="11" font-weight="700" fill="#172033" text-anchor="end">${escapeXml(m.requests)}</text>
      <text x="445" y="${y}" font-size="11" font-weight="500" fill="#7D8FA4" text-anchor="end">${escapeXml(m.share)}</text>
    `;
  }).join("\n");

  return `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 540 800" width="540" height="800">
  <defs>
    <filter id="companyCardShadow" x="-10%" y="-10%" width="130%" height="130%">
      <feDropShadow dx="0" dy="12" stdDeviation="18" flood-color="#0F1B2E" flood-opacity="0.06"/>
      <feDropShadow dx="0" dy="2" stdDeviation="4" flood-color="#0F1B2E" flood-opacity="0.03"/>
    </filter>
  </defs>

  <!-- Canvas Background -->
  <rect width="540" height="800" fill="#EEF2F6"/>

  <!-- White Floating Card (416x658 px, Scale 0.8, Safe Area X=62, Y=71) -->
  <rect x="62" y="71" width="416" height="658" rx="18" fill="#FFFFFF" stroke="#E2E8F0" stroke-width="1" filter="url(#companyCardShadow)"/>

  <g font-family="-apple-system, BlinkMacSystemFont, 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif">
    <!-- Section 1: Header -->
    <text x="94" y="118" font-size="24" font-weight="700" fill="#172033">全员用量周报小结<tspan dx="14" font-size="13" font-weight="600" fill="#417EE0">${escapeXml(data.dateRange)}</tspan></text>

    <!-- Section 2: 3 Big Numbers (14px Bold, Classic Black #172033) -->
    <!-- Number 1: Total Requests -->
    <g transform="translate(94, 150)">
      <text x="0" y="0" font-size="12" font-weight="500" fill="#7D8FA4">全周总请求数</text>
      <text x="0" y="24" font-size="14" font-weight="700" fill="#172033">${escapeXml(data.totalRequests)}</text>
    </g>

    <!-- Number 2: Total Tokens -->
    <g transform="translate(216, 150)">
      <text x="0" y="0" font-size="12" font-weight="500" fill="#7D8FA4">消耗总量</text>
      <text x="0" y="24" font-size="14" font-weight="700" fill="#172033">${escapeXml(data.totalTokens)}</text>
    </g>

    <!-- Number 3: Daily Avg Tokens (Black #172033) -->
    <g transform="translate(328, 150)">
      <text x="0" y="0" font-size="12" font-weight="500" fill="#7D8FA4">团队日均使用量</text>
      <text x="0" y="24" font-size="14" font-weight="700" fill="#172033">${escapeXml(data.dailyAvgTokens)}</text>
    </g>

    <line x1="94" y1="198" x2="445" y2="198" stroke="#F2F5F8" stroke-width="1.1" />

    <!-- Section 3: 全员使用量 -->
    <text x="94" y="234" font-size="14" font-weight="700" fill="#172033">全员使用量</text>
    
    <!-- Table Headers (11px Medium) -->
    <text x="94" y="256" font-size="11" font-weight="500" fill="#7D8FA4">成员</text>
    <text x="210" y="256" font-size="11" font-weight="500" fill="#7D8FA4" text-anchor="end">请求数</text>
    <text x="286" y="256" font-size="11" font-weight="500" fill="#7D8FA4" text-anchor="end">7天总消耗</text>
    <text x="382" y="256" font-size="11" font-weight="500" fill="#7D8FA4" text-anchor="end">日均使用量</text>
    <text x="445" y="256" font-size="11" font-weight="500" fill="#7D8FA4" text-anchor="end">占比</text>
    <line x1="94" y1="264" x2="445" y2="264" stroke="#F2F5F8" stroke-width="1.1" />

    <!-- Table Rows (11px Bold) -->
    ${userRowsSvg}

    <line x1="94" y1="392" x2="445" y2="392" stroke="#F2F5F8" stroke-width="1.1" />

    <!-- Section 4: 使用模型 -->
    <text x="94" y="416" font-size="14" font-weight="700" fill="#172033">使用模型</text>
    
    <!-- Model Table Headers -->
    <text x="94" y="432" font-size="11" font-weight="500" fill="#7D8FA4">模型名</text>
    <text x="238" y="432" font-size="11" font-weight="500" fill="#7D8FA4" text-anchor="end">7天消耗</text>
    <text x="330" y="432" font-size="11" font-weight="500" fill="#7D8FA4" text-anchor="end">日均消耗</text>
    <text x="396" y="432" font-size="11" font-weight="500" fill="#7D8FA4" text-anchor="end">请求数</text>
    <text x="445" y="432" font-size="11" font-weight="500" fill="#7D8FA4" text-anchor="end">占比</text>
    <line x1="94" y1="438" x2="445" y2="438" stroke="#F2F5F8" stroke-width="1.1" />

    <!-- Model Table Rows -->
    ${modelRowsSvg}

    <!-- Section 5: Brand Footer & Logo -->
    <text x="94" y="678" font-size="16" font-weight="700" fill="#172033">仟流智算</text>
    <text x="94" y="698" font-size="12" font-weight="500" fill="#7D8FA4" letter-spacing="0.8">Qianliu IC</text>

    <!-- Official Logo: 66x68 px, Right Anchor X=445, Bottom Y=698 -->
    <image href="${QIANLIU_LOGO_DATA_URI}" x="379" y="630" width="66" height="68"/>
  </g>
</svg>
`.trim();
}
