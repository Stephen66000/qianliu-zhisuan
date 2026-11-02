import { escapeXml } from "../format-utils.js";
import { QIANLIU_LOGO_DATA_URI } from "./logo-base64.js";

export interface PersonalWeeklyMetricItem {
  label: string;
  value: string;
  unit?: string;
  sub?: string;
}

export interface PersonalWeeklyReportData {
  userName: string;
  dateRange: string; // e.g. "一周小结 9.7-9.11"
  quote?: string;
  metrics: PersonalWeeklyMetricItem[];
}

/**
 * 场景一：员工个人周报信笺白卡
 * 严格遵循《仟流智算 · 个人周报小结视觉与格式规范 v1.0》：
 * - 画布 540x800，冷灰衬底 #EEF2F6；
 * - 浮动白卡 460x700，圆角 18px，双层浅微投影；
 * - X 轴双基线律动（主基线 X=94，缩进线 X=118，右锚定线 X=445）；
 * - Y 轴绝对等距居中（留白严格 71px:71px，内容包围盒 121~679 高度 558px）；
 * - 4 指标槽位 68px，5 指标动态收缩为 56px；最后一项指标下方仅预留 1 行手账横线。
 */
export function generatePersonalWeeklySvg(data: PersonalWeeklyReportData): string {
  const quote = data.quote || "功不求疾，但求有恒";
  const quoteFontSize = quote.length > 11 ? 22 : quote.length > 9 ? 24 : 26;
  const metricsCount = data.metrics.length;
  const wrap = (text: string) => {
    if (text.includes(" · ")) return text.split(" · ");
    const lines: string[] = []; let line = ""; let units = 0;
    for (const character of text) {
      const width = /[\u0000-\u007f]/.test(character) ? 0.55 : 1;
      if (units + width > 23 && line) { lines.push(line); line = ""; units = 0; }
      line += character; units += width;
    }
    if (line) lines.push(line);
    return lines;
  };
  const wrappedValues = data.metrics.map(metric => wrap(metric.value));
  const extraHeight = Math.max(0, metricsCount - 5) * 68 + wrappedValues.reduce((sum, lines) => sum + Math.max(0, lines.length - 1) * 18, 0);
  const isSixOrMore = metricsCount >= 6;
  const isFiveMetrics = metricsCount === 5;
  const slotHeight = 68;
  const firstLineY = isSixOrMore ? 244 : isFiveMetrics ? 254 : 262;

  // 生成各项指标与分割横线
  let linesSvg = "";
  let metricsSvg = "";

  // 1. 金句下方第一条横线
  linesSvg += `<line x1="94" y1="${firstLineY}" x2="445" y2="${firstLineY}" stroke="#F2F5F8" stroke-width="1.1" />\n`;

  let slotTop = firstLineY;
  data.metrics.forEach((m, idx) => {
    const valueLines = wrappedValues[idx]!;
    const nextLineY = slotTop + slotHeight + Math.max(0, valueLines.length - 1) * 18;
    const labelY = isSixOrMore ? slotTop + 19 : isFiveMetrics ? slotTop + 22 : slotTop + 26;
    const valueY = isSixOrMore ? labelY + 18 : isFiveMetrics ? labelY + 20 : labelY + 24;

    const unitText = m.unit ? ` ${escapeXml(m.unit)}` : "";
    const subText = m.sub ? ` <tspan font-size="12" font-weight="500" fill="#7D8FA4">${escapeXml(m.sub)}</tspan>` : "";

    metricsSvg += `
      <!-- 指标 ${idx + 1}: ${escapeXml(m.label)} -->
      <text x="118" y="${labelY}" font-size="13" font-weight="500" fill="#7D8FA4">${escapeXml(m.label)}</text>
      <text x="118" y="${valueY}" font-size="14" font-weight="700" fill="#172033">${valueLines.length === 1 ? escapeXml(m.value) : valueLines.map((line, lineIndex) => `<tspan x="118" dy="${lineIndex === 0 ? 0 : 18}">${escapeXml(line)}</tspan>`).join("")}${unitText}${subText}</text>
    `;

    // 指标之间的横线
    linesSvg += `<line x1="94" y1="${nextLineY}" x2="445" y2="${nextLineY}" stroke="#F2F5F8" stroke-width="1.1" />\n`;
    slotTop = nextLineY;
  });

  // 仅预留 1 行手账线（最后一项指标下方的横线已经在循环中添加，再预留 1 行空白手账线）
  const reservedLineY = firstLineY + (metricsCount + 1) * slotHeight;
  if (reservedLineY <= 610) {
    linesSvg += `<!-- 预留 1 行手账线 -->\n<line x1="94" y1="${reservedLineY}" x2="445" y2="${reservedLineY}" stroke="#F2F5F8" stroke-width="1.1" />\n`;
  }

  return `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="47 65 446 ${635 + extraHeight}" width="540" height="${769 + extraHeight * 540 / 446}">
  <!-- Pure White Background (Margins reduced by 50%) -->
  <rect x="47" y="65" width="446" height="${635 + extraHeight}" fill="#FFFFFF"/>

  <g font-family="-apple-system, BlinkMacSystemFont, 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'WenQuanYi Zen Hei', 'Noto Sans CJK SC', sans-serif">
    <!-- Header: User Name (26px Bold, #172033) & Date Range (13px Semibold, #417EE0) -->
    <text x="94" y="143" font-size="26" font-weight="700" fill="#172033">${escapeXml(data.userName)}</text>
    <text x="94" y="171" font-size="13" font-weight="600" fill="#417EE0">${escapeXml(data.dateRange)}</text>

    <text x="94" y="191" font-size="10" fill="#7D8FA4">成功请求统计；额度含失败实耗，按预占归属月计量</text>

    <!-- Quote Section: Distance 94px from Header (Y=237) -->
    <!-- Hanging Opening Quote at X=94 -->
    <text x="94" y="237" font-family="Georgia, serif" font-size="28" font-weight="700" fill="#D97706">“</text>
    <!-- Quote Text at X=118 -->
    <text x="118" y="237" font-size="${quoteFontSize}" font-weight="700" fill="#D97706">${escapeXml(quote)}<tspan font-family="Georgia, serif" font-size="28" font-weight="700" fill="#D97706"> ”</tspan></text>

    <!-- Ruled Lines -->
    ${linesSvg}

    <!-- Indicators -->
    ${metricsSvg}

    <!-- Brand Footer: Fixed Anchor -->
    <text x="94" y="${659 + extraHeight}" font-size="16" font-weight="700" fill="#172033">仟流智算</text>
    <text x="94" y="${679 + extraHeight}" font-size="12" font-weight="500" fill="#7D8FA4" letter-spacing="0.8">Qianliu IC</text>

    <!-- Official Logo: 38x38, Right Edge X=445, Blue Bottom Edge Y=679 (Aligned with Qianliu IC) -->
    <image href="${QIANLIU_LOGO_DATA_URI}" x="407" y="${641 + extraHeight}" width="38" height="38"/>
  </g>
</svg>
`.trim();
}
