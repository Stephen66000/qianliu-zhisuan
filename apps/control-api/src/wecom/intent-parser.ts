export type QueryScope = "SELF" | "TEAM";
export type QueryPeriod = "TODAY" | "YESTERDAY" | "WEEK" | "LAST_WEEK" | "MONTH" | "LAST_MONTH";

export interface ParsedIntent {
  isTokenQuery: boolean;
  period: QueryPeriod;
  scope: QueryScope;
  periodLabel: string;
  anchor: Date;
  overviewPeriod: "TODAY" | "WEEK" | "MONTH";
}

/**
 * 解析用户在企微窗口中发送的自然语言文本，提取查询意图与时间范围。
 */
export function parseQueryIntent(text: string, now: Date = new Date()): ParsedIntent {
  const normalized = text.trim().toLowerCase();

  // 1. 判断是否涉及 Token / 用量 / 消耗查询或周期问询
  const tokenKeywords = [
    "token", "用量", "消耗", "额度", "花费", "花费了多少", "用了多少", "调用", "账单", "统计",
  ];
  const periodKeywords = [
    "今天", "今日", "today",
    "昨天", "昨日", "yesterday",
    "上周", "上一周", "上个星期", "last week",
    "本周", "这周", "这个星期", "this week",
    "上月", "上个月", "last month",
    "本月", "这个月", "this month",
  ];

  const hasTokenKeyword = tokenKeywords.some((kw) => normalized.includes(kw));
  const hasPeriodKeyword = periodKeywords.some((kw) => normalized.includes(kw));

  // 如果既没有明确 token 关键词也没有任何周期词，判定为普通消息
  if (!hasTokenKeyword && !hasPeriodKeyword) {
    return {
      isTokenQuery: false,
      period: "TODAY",
      scope: "SELF",
      periodLabel: "今天",
      anchor: now,
      overviewPeriod: "TODAY",
    };
  }

  // 2. 判定查询范围：个人 vs 团队/全员
  const teamKeywords = ["全员", "团队", "全公司", "公司", "大家", "所有人", "部门"];
  const isTeam = teamKeywords.some((kw) => normalized.includes(kw));
  const scope: QueryScope = isTeam ? "TEAM" : "SELF";

  // 3. 判定时间范围
  if (normalized.includes("昨天") || normalized.includes("昨日") || normalized.includes("yesterday")) {
    const yesterday = new Date(now.getTime() - 24 * 3600_000);
    return {
      isTokenQuery: true,
      period: "YESTERDAY",
      scope,
      periodLabel: "昨天",
      anchor: yesterday,
      overviewPeriod: "TODAY",
    };
  }

  if (
    normalized.includes("上一周") ||
    normalized.includes("上周") ||
    normalized.includes("上个星期") ||
    normalized.includes("last week")
  ) {
    const lastWeek = new Date(now.getTime() - 7 * 24 * 3600_000);
    return {
      isTokenQuery: true,
      period: "LAST_WEEK",
      scope,
      periodLabel: "上一周",
      anchor: lastWeek,
      overviewPeriod: "WEEK",
    };
  }

  if (
    normalized.includes("本周") ||
    normalized.includes("这周") ||
    normalized.includes("这个星期") ||
    normalized.includes("this week")
  ) {
    return {
      isTokenQuery: true,
      period: "WEEK",
      scope,
      periodLabel: "本周",
      anchor: now,
      overviewPeriod: "WEEK",
    };
  }

  if (
    normalized.includes("上个月") ||
    normalized.includes("上月") ||
    normalized.includes("last month")
  ) {
    const prevMonth = new Date(now.getFullYear(), now.getMonth() - 1, 15);
    return {
      isTokenQuery: true,
      period: "LAST_MONTH",
      scope,
      periodLabel: "上个月",
      anchor: prevMonth,
      overviewPeriod: "MONTH",
    };
  }

  if (
    normalized.includes("本月") ||
    normalized.includes("这个月") ||
    normalized.includes("this month")
  ) {
    return {
      isTokenQuery: true,
      period: "MONTH",
      scope,
      periodLabel: "本月",
      anchor: now,
      overviewPeriod: "MONTH",
    };
  }

  // 默认为今天
  return {
    isTokenQuery: true,
    period: "TODAY",
    scope,
    periodLabel: "今天",
    anchor: now,
    overviewPeriod: "TODAY",
  };
}
