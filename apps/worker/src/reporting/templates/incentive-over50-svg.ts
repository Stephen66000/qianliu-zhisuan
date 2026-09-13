import { escapeXml } from "../format-utils.js";
import { QIANLIU_LOGO_DATA_URI } from "./logo-base64.js";

export interface IncentiveOver50ReportData {
  userName: string;
  monthTitle: string; // e.g. "9月份使用 Token 数量"
  quote?: string;     // 默认 "已经超过了 50% 的同事"
  performanceText?: string; // 默认 "领跑半数成员"
  performanceSub?: string;  // 默认 "位列团队前 50%"
  monthlyTokens: string;    // e.g. "68.5 万"
  totalRequests: string;    // e.g. "1,620 次"
  topModel: string;         // e.g. "DeepSeek V3 + GLM 5.3"
  topModelSub?: string;     // 默认 "深度推理与综合协作"
}

/**
 * 场景三(b)：激励卡片 · 超越 50% 员工成长卡
 * 遵循《仟流智算 · 激励卡片（超越 50% 员工）视觉与触发规范 v1.0》：
 * - 画布 540x800，冷灰背景 #EEF2F6；
 * - 浮动白卡 460x700 px，圆角 18px，Safe Area 71px:71px 绝对垂直居中；
 * - 大白话温暖沟通（“已经超过了 50% 的同事”）；
 * - 纯正智算硬核指标（表现、月累消耗、累计请求、主力模型）；
 * - 纯矢量设计，杜绝 Emoji。
 */
export function generateIncentiveOver50Svg(data: IncentiveOver50ReportData): string {
  const quote = data.quote || "已经超过了 50% 的同事";
  const firstLineY = 262;
  const slotHeight = 68;

  const perfText = data.performanceText || "领跑半数成员";
  const perfSub = data.performanceSub || "位列团队前 50%";
  const modelSub = data.topModelSub || "深度推理与综合协作";

  const slots = [
    {
      label: "表现",
      value: perfText,
      sub: `(${perfSub})`,
    },
    {
      label: "月累消耗总量",
      value: data.monthlyTokens,
      sub: undefined,
    },
    {
      label: "累计请求",
      value: data.totalRequests,
      sub: undefined,
    },
    {
      label: "主力模型",
      value: data.topModel,
      sub: undefined,
    },
  ];

  let linesSvg = `<line x1="94" y1="${firstLineY}" x2="445" y2="${firstLineY}" stroke="#F2F5F8" stroke-width="1.1" />\n`;
  let metricsSvg = "";

  slots.forEach((s, idx) => {
    const slotTop = firstLineY + idx * slotHeight;
    const nextLineY = slotTop + slotHeight;
    const labelY = slotTop + 26;
    const valueY = labelY + 24;

    const subSvg = s.sub ? ` <tspan font-size="12" font-weight="500" fill="#7D8FA4">${escapeXml(s.sub)}</tspan>` : "";

    metricsSvg += `
      <!-- Slot ${idx + 1}: ${escapeXml(s.label)} -->
      <text x="118" y="${labelY}" font-size="13" font-weight="500" fill="#7D8FA4">${escapeXml(s.label)}</text>
      <text x="118" y="${valueY}" font-size="14" font-weight="700" fill="#172033">${escapeXml(s.value)}${subSvg}</text>
    `;

    linesSvg += `<line x1="94" y1="${nextLineY}" x2="445" y2="${nextLineY}" stroke="#F2F5F8" stroke-width="1.1" />\n`;
  });

  // 预留 1 行手账线
  const reservedLineY = firstLineY + 5 * slotHeight;
  linesSvg += `<!-- 预留 1 行手账线 -->\n<line x1="94" y1="${reservedLineY}" x2="445" y2="${reservedLineY}" stroke="#F2F5F8" stroke-width="1.1" />\n`;

  return `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="47 65 446 635" width="540" height="769">
  <!-- Pure White Background (Margins reduced by 50%) -->
  <rect x="47" y="65" width="446" height="635" fill="#FFFFFF"/>

  <g font-family="-apple-system, BlinkMacSystemFont, 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'WenQuanYi Zen Hei', 'Noto Sans CJK SC', sans-serif">
    <!-- Header: User Name (24px Bold, #172033) & Month Title (13px Semibold, #417EE0) -->
    <text x="94" y="143" font-size="24" font-weight="700" fill="#172033">${escapeXml(data.userName)}<tspan dx="14" font-size="13" font-weight="600" fill="#417EE0">${escapeXml(data.monthTitle)}</tspan></text>

    <!-- Proclamation Section: Distance 94px from Header (Y=237) -->
    <!-- Hanging Opening Quote at X=94 -->
    <text x="94" y="237" font-family="Georgia, serif" font-size="28" font-weight="700" fill="#D97706">“</text>
    <!-- Proclamation Text at X=118 -->
    <text x="118" y="237" font-size="24" font-weight="700" fill="#D97706">${escapeXml(quote)}<tspan font-family="Georgia, serif" font-size="28" font-weight="700" fill="#D97706"> ”</tspan></text>

    <!-- Ruled Lines -->
    ${linesSvg}

    <!-- Core Metrics -->
    ${metricsSvg}

    <!-- Brand Footer -->
    <text x="94" y="659" font-size="16" font-weight="700" fill="#172033">仟流智算</text>
    <text x="94" y="679" font-size="12" font-weight="500" fill="#7D8FA4" letter-spacing="0.8">Qianliu IC</text>

    <!-- Official Logo: 70x72, Right Edge X=445, Bottom Edge Y=679 -->
    <image href="${QIANLIU_LOGO_DATA_URI}" x="375" y="607" width="70" height="72"/>
  </g>
</svg>
`.trim();
}
