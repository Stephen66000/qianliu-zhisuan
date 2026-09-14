import { escapeXml } from "../format-utils.js";
import { QIANLIU_LOGO_DATA_URI } from "./logo-base64.js";

export interface IncentiveTop1ReportData {
  userName: string;
  periodLabel: string; // e.g. "登顶周榜首 · 9.7-9.13 (第37周)"
  quote?: string;      // 默认 "独行快，众行远；引领者无畏"
  weeklyTokens: string; // e.g. "128.0 万"
  teamShare: string;    // e.g. "33.3%"
  exceededPercent?: string; // e.g. "超越全员 99% 同事"
  topModel: string;     // e.g. "DeepSeek V3"
  topModelSub?: string; // e.g. "高频深度推理与代码"
}

/**
 * 场景三(a)：激励卡片 · 登顶第 1 名流动红旗
 * 遵循《仟流智算 · 激励卡片（登顶第 1 名）视觉与触发规范 v1.0》：
 * - 画布 540x800，冷灰背景 #EEF2F6；
 * - 浮动白卡 460x700 px，圆角 18px，Safe Area 71px:71px 等距垂直居中；
 * - X 轴双基准（主基准 X=94，缩进 X=118，右锚定 X=445）；
 * - 核心排位采用专属琥珀暖金点睛（#D97706）；
 * - 纯矢量设计，严禁 Emoji。
 */
export function generateIncentiveTop1Svg(data: IncentiveTop1ReportData): string {
  const quote = data.quote || "独行快，众行远；引领者无畏";
  const quoteFontSize = quote.length > 13 ? 20 : quote.length > 11 ? 22 : quote.length > 9 ? 24 : 26;
  const firstLineY = 262;
  const slotHeight = 68;

  const exceededText = data.exceededPercent || "超越全员 99% 同事";

  const slots = [
    {
      label: "全员用量排位",
      value: "第 1 名",
      isGold: true,
      sub: "(全团队榜首 · 领跑全员)",
    },
    {
      label: "周消耗 Token 总量",
      value: data.weeklyTokens,
      isGold: false,
      sub: undefined,
    },
    {
      label: "团队消耗贡献占比",
      value: data.teamShare,
      isGold: false,
      sub: `(${exceededText})`,
    },
    {
      label: "使用模型",
      value: data.topModel,
      isGold: false,
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

    const valueColor = s.isGold ? "#D97706" : "#172033";
    const subSvg = s.sub ? ` <tspan font-size="12" font-weight="500" fill="#7D8FA4">${escapeXml(s.sub)}</tspan>` : "";

    metricsSvg += `
      <!-- Slot ${idx + 1}: ${escapeXml(s.label)} -->
      <text x="118" y="${labelY}" font-size="13" font-weight="500" fill="#7D8FA4">${escapeXml(s.label)}</text>
      <text x="118" y="${valueY}" font-size="14" font-weight="700" fill="${valueColor}">${escapeXml(s.value)}${subSvg}</text>
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
    <!-- Header: User Name (24px Bold, #172033) & Honor Subtitle (12px Semibold, #417EE0) -->
    <text x="94" y="143" font-size="24" font-weight="700" fill="#172033">${escapeXml(data.userName)}<tspan dx="14" font-size="12" font-weight="600" fill="#417EE0">${escapeXml(data.periodLabel)}</tspan></text>

    <!-- Quote Section: Distance 94px from Header (Y=237) -->
    <!-- Hanging Opening Quote at X=94 -->
    <text x="94" y="237" font-family="Georgia, serif" font-size="28" font-weight="700" fill="#D97706">“</text>
    <!-- Honor Quote Text at X=118 -->
    <text x="118" y="237" font-size="${quoteFontSize}" font-weight="700" fill="#D97706">${escapeXml(quote)}<tspan font-family="Georgia, serif" font-size="28" font-weight="700" fill="#D97706"> ”</tspan></text>

    <!-- Ruled Lines -->
    ${linesSvg}

    <!-- Core Metrics -->
    ${metricsSvg}

    <!-- Brand Footer -->
    <text x="94" y="659" font-size="16" font-weight="700" fill="#172033">仟流智算</text>
    <text x="94" y="679" font-size="12" font-weight="500" fill="#7D8FA4" letter-spacing="0.8">Qianliu IC</text>

    <!-- Official Logo: 38x38, Right Edge X=445, Blue Bottom Edge Y=679 (Aligned with Qianliu IC) -->
    <image href="${QIANLIU_LOGO_DATA_URI}" x="407" y="641" width="38" height="38"/>
  </g>
</svg>
`.trim();
}
