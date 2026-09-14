import { escapeXml } from "../format-utils.js";
import { QIANLIU_LOGO_DATA_URI } from "./logo-base64.js";

export interface DailyUserRow {
  rank: number;
  name: string;
  department: string;
  requests: string; // e.g. "245"
  tokens: string;   // e.g. "4,207.8 万"
  share: string;    // e.g. "100.0%"
}

export interface DailyModelRow {
  model: string;    // e.g. "智谱 GLM-5.3"
  tokens: string;   // e.g. "2,131.2 万"
  requests: string; // e.g. "79"
  share: string;    // e.g. "50.6%"
}

export interface DailyTokenReportData {
  enterpriseName: string;
  reportDate: string;        // e.g. "9.13 (昨日全天)"
  totalRequests: string;    // e.g. "245"
  totalTokens: string;      // e.g. "4,207.8 万"
  activeEmployees: number;  // e.g. 1
  totalEmployees?: number;  // e.g. 4
  topUsers: DailyUserRow[];
  topModels: DailyModelRow[];
}

/**
 * 场景：每日全员 Token 消费日报（管理看板）
 * - 纯白背景 #FFFFFF，移动端竖版设计规范；
 * - 画布 540x760，顶部与底部固定安全边距（SAFE_MARGIN_Y = 56px）；
 * - 左右安全边距 52px（内容宽度 436px），画面饱满对称；
 * - 4 大内容段在中间安全区域内自适应垂直弹性排列：
 *   1. 标题（公司名 · Token日报 + 日期小结）
 *   2. 核心三大数字（昨日总请求数、Token消耗总量、活跃员工数，宽列距展开）
 *   3. 全员使用量表格（动态适应 1~7 行，成员与指标列精细排布，彻底杜绝重合）
 *   4. 使用模型表格（动态适应 1~3 行，直连官方模型显示名）
 *   5. 品牌底栏与官方矢量 Logo（右侧对齐）
 * - 纯矢量设计，严禁 Emoji。
 */
export function generateDailyTokenReportSvg(data: DailyTokenReportData): string {
  const cardWidth = 540;
  const cardHeight = 760;
  const SAFE_MARGIN_Y = 56;
  const X_LEFT = 52;
  const X_RIGHT = 488;

  const topSafe = SAFE_MARGIN_Y;
  const bottomSafe = cardHeight - SAFE_MARGIN_Y;

  // 测量 4 大主区块固有高度
  // Block 1: 顶栏组合（标题 20px + 间距 44px + 3大数字 46px）= 110px
  const hBlock1 = 110;
  // Block 2: 全员使用量表格（区块标题 20px + 表头 16px + 用户数据行）
  const userRowStep = 24;
  const userRowCount = Math.min(data.topUsers.length, 7);
  const hBlock2 = 36 + userRowCount * userRowStep;
  // Block 3: 使用模型表格（区块标题 20px + 表头 16px + 模型数据行）
  const modelRowStep = 24;
  const modelRowCount = Math.min(data.topModels.length, 3);
  const hBlock3 = 36 + modelRowCount * modelRowStep;
  // Block 4: 品牌底栏（38px）
  const hBlock4 = 38;

  const totalContentHeight = hBlock1 + hBlock2 + hBlock3 + hBlock4;
  const remainingSpace = (bottomSafe - topSafe) - totalContentHeight;
  const majorGap = Math.max(26, remainingSpace / 3);

  // 1. Block 1: 顶栏组合
  const b1Top = topSafe;
  const headerY = b1Top + 22;
  const kpiTopY = headerY + 44;

  // 分割线 1
  const div1Y = b1Top + hBlock1 + majorGap / 2;

  // 2. Block 2: 全员使用量表格
  const b2Top = b1Top + hBlock1 + majorGap;
  const table1TitleY = b2Top + 14;
  const table1HeaderY = table1TitleY + 20;
  const userRowStartY = table1HeaderY + 22;

  // 分割线 2
  const div2Y = b2Top + hBlock2 + majorGap / 2;

  // 3. Block 3: 使用模型表格
  const b3Top = b2Top + hBlock2 + majorGap;
  const table2TitleY = b3Top + 14;
  const table2HeaderY = table2TitleY + 20;
  const modelRowStartY = table2HeaderY + 22;

  // 分割线 3
  const div3Y = b3Top + hBlock3 + majorGap / 2;

  // 4. Block 4: 品牌底栏
  const b4Top = b3Top + hBlock3 + majorGap;
  const brandTitleY = b4Top + 16;
  const brandSubY = brandTitleY + 18;
  const logoTopY = brandSubY - 38;

  // 渲染全员使用量数据行
  const userRowsSvg = data.topUsers.slice(0, 7).map((u, i) => {
    const y = userRowStartY + i * userRowStep;

    let rankBadgeSvg = "";
    if (u.rank === 1) {
      rankBadgeSvg = `
        <circle cx="62" cy="${y - 4}" r="7.5" fill="#FEF3C7" />
        <text x="62" y="${y}" font-size="9.5" font-weight="700" fill="#D97706" text-anchor="middle">1</text>
      `;
    } else if (u.rank === 2) {
      rankBadgeSvg = `
        <circle cx="62" cy="${y - 4}" r="7.5" fill="#E2E8F0" />
        <text x="62" y="${y}" font-size="9.5" font-weight="700" fill="#64748B" text-anchor="middle">2</text>
      `;
    } else if (u.rank === 3) {
      rankBadgeSvg = `
        <circle cx="62" cy="${y - 4}" r="7.5" fill="#FFEDD5" />
        <text x="62" y="${y}" font-size="9.5" font-weight="700" fill="#EA580C" text-anchor="middle">3</text>
      `;
    } else {
      rankBadgeSvg = `
        <text x="62" y="${y}" font-size="10" font-weight="500" fill="#94A3B8" text-anchor="middle">${u.rank}</text>
      `;
    }

    const reqClean = u.requests.replace(/\s*次$/, "");
    const tokensClean = u.tokens.replace(/\s*万$/, "").replace(/\s*亿$/, "");
    const tokensUnit = u.tokens.includes("亿") ? "亿" : "万";

    return `
      <!-- Row ${i + 1}: ${escapeXml(u.name)} -->
      ${rankBadgeSvg}
      <text x="80" y="${y}" font-size="10.5" font-weight="700" fill="#172033">${escapeXml(u.name)}</text>
      <text x="134" y="${y}" font-size="9.5" font-weight="500" fill="#7D8FA4">${escapeXml(u.department || "-")}</text>
      <text x="285" y="${y}" font-size="10.5" font-weight="600" fill="#172033" text-anchor="end">${escapeXml(reqClean)} <tspan font-size="9" font-weight="500" fill="#7D8FA4">次</tspan></text>
      <text x="405" y="${y}" font-size="10.5" font-weight="600" fill="#172033" text-anchor="end">${escapeXml(tokensClean)} <tspan font-size="9" font-weight="500" fill="#7D8FA4">${tokensUnit}</tspan></text>
      <text x="${X_RIGHT}" y="${y}" font-size="10" font-weight="500" fill="#7D8FA4" text-anchor="end">${escapeXml(u.share)}</text>
    `;
  }).join("\n");

  // 渲染使用模型数据行
  const modelRowsSvg = data.topModels.slice(0, 3).map((m, i) => {
    const y = modelRowStartY + i * modelRowStep;
    const mTokensClean = m.tokens.replace(/\s*万$/, "").replace(/\s*亿$/, "");
    const mTokensUnit = m.tokens.includes("亿") ? "亿" : "万";
    const mReqClean = m.requests.replace(/\s*次$/, "");

    return `
      <!-- Model Row ${i + 1}: ${escapeXml(m.model)} -->
      <text x="${X_LEFT}" y="${y}" font-size="10.5" font-weight="700" fill="#172033">${escapeXml(m.model)}</text>
      <text x="265" y="${y}" font-size="10.5" font-weight="600" fill="#172033" text-anchor="end">${escapeXml(mTokensClean)} <tspan font-size="9" font-weight="500" fill="#7D8FA4">${mTokensUnit}</tspan></text>
      <text x="390" y="${y}" font-size="10.5" font-weight="600" fill="#172033" text-anchor="end">${escapeXml(mReqClean)} <tspan font-size="9" font-weight="500" fill="#7D8FA4">次</tspan></text>
      <text x="${X_RIGHT}" y="${y}" font-size="10" font-weight="500" fill="#7D8FA4" text-anchor="end">${escapeXml(m.share)}</text>
    `;
  }).join("\n");

  const totalReqClean = data.totalRequests.replace(/\s*次$/, "");
  const totalTokensClean = data.totalTokens.replace(/\s*万$/, "").replace(/\s*亿$/, "");
  const totalTokensUnit = data.totalTokens.includes("亿") ? "亿" : "万";

  return `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${cardWidth} ${cardHeight}" width="${cardWidth}" height="${cardHeight}">
  <!-- Pure White Background -->
  <rect x="0" y="0" width="${cardWidth}" height="${cardHeight}" fill="#FFFFFF"/>

  <g font-family="-apple-system, BlinkMacSystemFont, 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'WenQuanYi Zen Hei', 'Noto Sans CJK SC', sans-serif">
    <!-- Block 1: 顶栏小结 (公司名 · Token日报 + 日期 + 3大数字) -->
    <text x="${X_LEFT}" y="${headerY}" font-size="20" font-weight="700" fill="#172033">${escapeXml(data.enterpriseName)} · Token日报<tspan dx="12" font-size="12" font-weight="600" fill="#417EE0">${escapeXml(data.reportDate)}</tspan></text>

    <!-- 3 大核心数字水平排列 (加大列距，充盈空间) -->
    <g transform="translate(${X_LEFT}, ${kpiTopY})">
      <text x="0" y="0" font-size="10.5" font-weight="500" fill="#7D8FA4">昨日总请求次数</text>
      <text x="0" y="28" font-size="21" font-weight="700" fill="#172033">${escapeXml(totalReqClean)} <tspan font-size="15" font-weight="500" fill="#7D8FA4">次</tspan></text>
    </g>

    <g transform="translate(216, ${kpiTopY})">
      <text x="0" y="0" font-size="10.5" font-weight="500" fill="#7D8FA4">昨日 Token 消耗总量</text>
      <text x="0" y="28" font-size="21" font-weight="700" fill="#172033">${escapeXml(totalTokensClean)} <tspan font-size="15" font-weight="500" fill="#7D8FA4">${totalTokensUnit}</tspan></text>
    </g>

    <g transform="translate(380, ${kpiTopY})">
      <text x="0" y="0" font-size="10.5" font-weight="500" fill="#7D8FA4">活跃员工数</text>
      <text x="0" y="28" font-size="21" font-weight="700" fill="#172033">${data.activeEmployees} <tspan font-size="15" font-weight="500" fill="#7D8FA4">人</tspan></text>
    </g>

    <!-- 分割线 1 -->
    <line x1="${X_LEFT}" y1="${div1Y}" x2="${X_RIGHT}" y2="${div1Y}" stroke="#F1F5F9" stroke-width="1" />

    <!-- Block 2: 全员使用量表格 -->
    <text x="${X_LEFT}" y="${table1TitleY}" font-size="13" font-weight="700" fill="#172033">全员昨日使用量</text>
    <text x="${X_RIGHT}" y="${table1TitleY}" font-size="10" font-weight="500" fill="#7D8FA4" text-anchor="end">昨日活跃 ${data.activeEmployees} 人</text>

    <!-- 列标题：精密排布，彻底消除重叠 -->
    <text x="62" y="${table1HeaderY}" font-size="10" font-weight="500" fill="#7D8FA4" text-anchor="middle">排名</text>
    <text x="80" y="${table1HeaderY}" font-size="10" font-weight="500" fill="#7D8FA4">成员</text>
    <text x="134" y="${table1HeaderY}" font-size="10" font-weight="500" fill="#7D8FA4">所属团队</text>
    <text x="285" y="${table1HeaderY}" font-size="10" font-weight="500" fill="#7D8FA4" text-anchor="end">请求数</text>
    <text x="405" y="${table1HeaderY}" font-size="10" font-weight="500" fill="#7D8FA4" text-anchor="end">昨日消耗</text>
    <text x="${X_RIGHT}" y="${table1HeaderY}" font-size="10" font-weight="500" fill="#7D8FA4" text-anchor="end">占比</text>

    <!-- 用户数据行 -->
    ${userRowsSvg}

    <!-- 分割线 2 -->
    <line x1="${X_LEFT}" y1="${div2Y}" x2="${X_RIGHT}" y2="${div2Y}" stroke="#F1F5F9" stroke-width="1" />

    <!-- Block 3: 使用模型表格 -->
    <text x="${X_LEFT}" y="${table2TitleY}" font-size="13" font-weight="700" fill="#172033">使用模型</text>
    <text x="${X_RIGHT}" y="${table2TitleY}" font-size="10" font-weight="500" fill="#7D8FA4" text-anchor="end">昨日调用 ${data.topModels.length} 个模型</text>

    <text x="${X_LEFT}" y="${table2HeaderY}" font-size="10" font-weight="500" fill="#7D8FA4">模型</text>
    <text x="265" y="${table2HeaderY}" font-size="10" font-weight="500" fill="#7D8FA4" text-anchor="end">昨日消耗</text>
    <text x="390" y="${table2HeaderY}" font-size="10" font-weight="500" fill="#7D8FA4" text-anchor="end">请求数</text>
    <text x="${X_RIGHT}" y="${table2HeaderY}" font-size="10" font-weight="500" fill="#7D8FA4" text-anchor="end">占比</text>

    <!-- 模型数据行 -->
    ${modelRowsSvg}

    <!-- 分割线 3 -->
    <line x1="${X_LEFT}" y1="${div3Y}" x2="${X_RIGHT}" y2="${div3Y}" stroke="#F1F5F9" stroke-width="1" />

    <!-- Block 4: 品牌底栏 -->
    <text x="${X_LEFT}" y="${brandTitleY}" font-size="15" font-weight="700" fill="#172033">仟流智算</text>
    <text x="${X_LEFT}" y="${brandSubY}" font-size="11" font-weight="500" fill="#7D8FA4" letter-spacing="0.8">Qianliu IC</text>

    <!-- 官方矢量 Logo：38x38，右边缘对齐 X_RIGHT -->
    <image href="${QIANLIU_LOGO_DATA_URI}" x="450" y="${logoTopY}" width="38" height="38"/>
  </g>
</svg>
`.trim();
}
