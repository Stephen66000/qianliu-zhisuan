import { sql, type Kysely } from "kysely";
import type { Database } from "@qianliu/database";
import { UsageOverviewRepository } from "@qianliu/database";
import { parseQueryIntent, type ParsedIntent } from "./intent-parser.js";
import { formatModelName } from "@qianliu/domain";

/**
 * 格式化普通计数值（如请求次数、人次），采用千分位隔开。
 */
export function formatNumber(num: number | string | bigint): string {
  const n = typeof num === "bigint" ? Number(num) : typeof num === "string" ? Number(num) : num;
  if (!Number.isFinite(n)) return "0";
  return n.toLocaleString("zh-CN");
}

/**
 * Token 统一计量换算（严格依循《仟流视觉法则》与《个人周报规范》标准）：
 * 1. 杜绝千分位长数字，统一换算为“万”或“亿”；
 * 2. 保留 1 位小数，四舍五入；
 * 3. < 1 亿使用“万”，>= 1 亿使用“亿”；
 * 4. 可选配置是否带日均后缀（万 /天）或单词后缀（Tokens）。
 */
export function formatTokenVolume(
  tokens: number | string | bigint,
  options?: { isDailyAvg?: boolean; showTokensWord?: boolean },
): string {
  const n = typeof tokens === "bigint" ? Number(tokens) : typeof tokens === "string" ? Number(tokens) : tokens;
  const isDaily = options?.isDailyAvg ?? false;
  const suffix = options?.showTokensWord ? " Tokens" : "";

  if (!Number.isFinite(n) || n <= 0) {
    const unit = isDaily ? "万 /天" : "万";
    return `0.0 ${unit}${suffix}`;
  }

  if (n >= 100_000_000) {
    const val = (n / 100_000_000).toFixed(1);
    const unit = isDaily ? "亿 /天" : "亿";
    return `${val} ${unit}${suffix}`;
  }

  const val = (n / 10_000).toFixed(1);
  const unit = isDaily ? "万 /天" : "万";
  return `${val} ${unit}${suffix}`;
}

/**
 * 格式化百分比比例（如 "0.333333" -> "33.3%"）
 */
export function formatPercentage(share: string | number): string {
  if (typeof share === "string" && share.includes("%")) return share;
  const num = typeof share === "string" ? parseFloat(share) : share;
  if (!Number.isFinite(num) || num <= 0) return "0.0%";
  return `${(num * 100).toFixed(1)}%`;
}

/**
 * 格式化时间区间展示
 */
export function formatDateRange(fromIso: string, toIso: string, timezone: string): string {
  try {
    const from = new Date(fromIso);
    const to = new Date(toIso);
    const dtf = new Intl.DateTimeFormat("zh-CN", {
      timeZone: timezone || "Asia/Shanghai",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    return `${dtf.format(from)} ~ ${dtf.format(to)}`;
  } catch {
    return `${fromIso.slice(0, 10)} ~ ${toIso.slice(0, 10)}`;
  }
}

export interface ModelDistributionItem {
  modelName: string;
  totalTokens: bigint;
  requestCount: number;
  percentage: string;
}

/**
 * 聚合查询指定企业、时间范围及主体的 Top 3 主力模型分布
 */
export async function queryTopModels(
  db: Kysely<Database>,
  enterpriseId: string,
  rangeStart: Date,
  rangeEnd: Date,
  principalId?: string,
): Promise<ModelDistributionItem[]> {
  try {
    const principalFilter = principalId ? sql`AND lt.principal_id = ${principalId}` : sql``;
    const result = await sql<{
      model_name: string | null;
      request_count: string | number | bigint;
      total_tokens: string | number | bigint;
    }>`
      SELECT ar.unified_model AS model_name,
             COUNT(ar.id) AS request_count,
             COALESCE(SUM(lt.total_input_tokens + lt.total_output_tokens), 0) AS total_tokens
        FROM ledger_transaction lt
        JOIN ai_request ar
          ON ar.id = lt.ai_request_id AND ar.enterprise_id = lt.enterprise_id
       WHERE lt.enterprise_id = ${enterpriseId}
         AND lt.status = 'SETTLED'
         AND ar.status = 'SUCCEEDED'
         AND lt.created_at >= ${rangeStart}
         AND lt.created_at < ${rangeEnd}
         ${principalFilter}
       GROUP BY ar.unified_model
       ORDER BY total_tokens DESC, request_count DESC
       LIMIT 3
    `.execute(db);

    const rows = result.rows || [];
    const totalSum = rows.reduce(
      (acc, r) => acc + BigInt(r.total_tokens ?? 0),
      0n,
    );

    return rows.map((r) => {
      const tokens = BigInt(r.total_tokens ?? 0);
      const pct = totalSum > 0n
        ? `${((Number(tokens) / Number(totalSum)) * 100).toFixed(1)}%`
        : "0.0%";
      return {
        modelName: formatModelName(r.model_name ?? "通用模型"),
        totalTokens: tokens,
        requestCount: Number(r.request_count ?? 0),
        percentage: pct,
      };
    });
  } catch {
    return [];
  }
}

/**
 * 微信自建应用交互消息处理器。
 * 返回需要给用户回复的纯文本消息内容。
 */
// eslint-disable-next-line complexity -- 已登记例外（2026-09-14 I1 审核）：企微消息意图分发入口，后续按意图类型提取 handler。
export async function handleWecomMessage(
  db: Kysely<Database>,
  fromUserName: string,
  content: string,
  now: Date = new Date(),
): Promise<string> {
  const intent: ParsedIntent = parseQueryIntent(content, now);

  if (!intent.isTokenQuery) {
    return [
      "您好！我是【仟流智算】AI 助手 🤖",
      "",
      "您可以随时向我发送以下指令查询 Token 消耗：",
      "• 「今天我用了多少token」",
      "• 「昨天消耗」",
      "• 「本周用量」",
      "• 「上一周我用了多少token」",
      "• 「本月用量」",
      "",
      "💡 发送后将即时为您统计并汇总对应周期的 Token 消耗与模型明细。",
    ].join("\n");
  }

  // 1. 查询发送者的企业微信人员绑定
  const identity = await db
    .selectFrom("person_external_identity as pei")
    .innerJoin("person as p", "p.id", "pei.person_id")
    .select([
      "pei.enterprise_id",
      "pei.person_id",
      "p.name as person_name",
      "p.department_label",
      "p.email",
    ])
    .where("pei.provider", "=", "WECOM")
    .where("pei.provider_user_id", "=", fromUserName)
    .where("pei.status", "=", "ACTIVE")
    .executeTakeFirst();

  if (!identity) {
    return [
      "⚠️ 【未关联身份】",
      `未找到您企业微信账号（${fromUserName}）关联的仟流智算人员档案。`,
      "",
      "请联系企业管理员在管理后台完成人员导入与身份关联。",
    ].join("\n");
  }

  // 2. 查询绑定的 AI 员工使用主体
  const principal = await db
    .selectFrom("principal")
    .select(["id", "name"])
    .where("enterprise_id", "=", identity.enterprise_id)
    .where("person_id", "=", identity.person_id)
    .where("type", "=", "EMPLOYEE")
    .executeTakeFirst();

  if (!principal) {
    return [
      "⚠️ 【主体未开通】",
      `您好，${identity.person_name}！`,
      "您的人员档案已同步，但尚未开通 AI 员工使用主体。",
      "",
      "请联系企业管理员在【使用主体】中为您开通，开通后即可自动分配模型额度与统计用量。",
    ].join("\n");
  }

  // 3. 校验团队查询权限 (管理员才允许查全员)
  let actualScope = intent.scope;
  let permissionNotice = "";

  if (intent.scope === "TEAM") {
    const admin = await db
      .selectFrom("admin_user")
      .select("id")
      .where("enterprise_id", "=", identity.enterprise_id)
      .where("status", "=", "ACTIVE")
      .where((eb) =>
        eb.or([
          identity.email ? eb("username", "=", identity.email) : eb.val(false),
          eb("username", "=", identity.person_name),
        ]),
      )
      .executeTakeFirst();

    if (!admin) {
      actualScope = "SELF";
      permissionNotice = "（注：您当前为员工主体，已为您展示个人用量数据）\n\n";
    }
  }

  // 4. 查询用量数据
  const usageRepo = new UsageOverviewRepository(db, () => now);

  try {
    // 无论是团队全员还是个人，统一优先获取团队全员维度 overview (获得全局范围、全员总消耗及成员排行榜 ranking)
    const teamOverview = await usageRepo.getOverview({
      enterpriseId: identity.enterprise_id,
      subjectType: "EMPLOYEE",
      period: intent.overviewPeriod,
      anchor: intent.anchor,
    });

    const timeRangeStr = formatDateRange(teamOverview.range.from, teamOverview.range.to, teamOverview.timezone);
    const rangeStart = new Date(teamOverview.range.from);
    const rangeEnd = new Date(teamOverview.range.to);

    if (actualScope === "TEAM") {
      const metrics = teamOverview.metrics;
      const topRanking = teamOverview.ranking.slice(0, 5);
      const topModels = await queryTopModels(db, identity.enterprise_id, rangeStart, rangeEnd);
      const modelStr = topModels.length > 0
        ? topModels.map((m) => `${m.modelName} (占 ${m.percentage})`).join("、")
        : Number(metrics.realTokens) > 0 ? "多模型协同" : "暂无调用记录";

      const rankingLines = topRanking.length > 0
        ? [
            "",
            "🏆 【成员消耗 Top 5】:",
            ...topRanking.map(
              (item, idx) =>
                ` ${idx + 1}. ${item.subjectName}${item.departmentLabel ? ` (${item.departmentLabel})` : ""}: ${formatTokenVolume(item.realTokens)} (${formatPercentage(item.share)})`,
            ),
          ]
        : ["", "暂无成员用量排行数据"];

      return [
        "🏢 【仟流智算 · 全员用量统计】",
        `⏱ 统计周期：${intent.periodLabel} (${timeRangeStr})`,
        "━━━━━━━━━━━━━━━━━━",
        `🔹 全员总消耗：${formatTokenVolume(metrics.realTokens, { showTokensWord: true })}`,
        `   • 输入消耗：${formatTokenVolume(metrics.inputTokens)}`,
        `   • 输出消耗：${formatTokenVolume(metrics.outputTokens)}`,
        `   • 缓存命中：${formatTokenVolume(metrics.cacheTokens, { showTokensWord: true })}`,
        `🔹 发起调用次数：${formatNumber(metrics.requestCount)} 次`,
        `🔹 活跃员工数：${metrics.activeSubjects} 人`,
        `🔹 主力协同模型：${modelStr}`,
        ...rankingLines,
        "━━━━━━━━━━━━━━━━━━",
        "💡 提示：管理员可随时发送“今天”、“昨天”、“本周”、“上周”、“本月”快速查询全员用量。",
      ].join("\n");
    }

    // 个人用量分支 (actualScope === "SELF")
    // 从团队 ranking 中匹配当前员工
    const userRankIdx = teamOverview.ranking.findIndex((r) => r.subjectId === principal.id);
    const userRankItem = userRankIdx >= 0 ? teamOverview.ranking[userRankIdx] : null;

    // 如果 ranking 中未出现（可能超出前100或0消耗），且有单独查询需要，尝试获取个人独立 overview
    let userMetrics = userRankItem;
    if (!userMetrics) {
      try {
        const personalOverview = await usageRepo.getOverview({
          enterpriseId: identity.enterprise_id,
          subjectType: "EMPLOYEE",
          subjectId: principal.id,
          period: intent.overviewPeriod,
          anchor: intent.anchor,
        });
        userMetrics = {
          ...personalOverview.metrics,
          subjectId: principal.id,
          subjectName: identity.person_name,
          departmentLabel: identity.department_label,
          share: "0",
          allocatedQuota: "0",
        };
      } catch (err: unknown) {
        console.warn("[wecom-message] 获取个人用量概览异常，降级为空数据:",
          err instanceof Error ? err.message : String(err));
      }
    }

    const realTokens = userMetrics?.realTokens ?? "0";
    const inputTokens = userMetrics?.inputTokens ?? "0";
    const outputTokens = userMetrics?.outputTokens ?? "0";
    const cacheTokens = userMetrics?.cacheTokens ?? "0";
    const requestCount = userMetrics?.requestCount ?? "0";

    const topModels = await queryTopModels(db, identity.enterprise_id, rangeStart, rangeEnd, principal.id);
    const realTokensNum = Number(realTokens);
    const modelStr = topModels.length > 0
      ? topModels.map((m) => `${m.modelName} (占 ${m.percentage})`).join("、")
      : realTokensNum > 0 ? "多模型协同" : "暂无模型调用记录";

    // 计算团队表现与激励提示语
    let performanceTip = "";
    const totalMembers = teamOverview.ranking.length;

    if (realTokensNum <= 0) {
      performanceTip = "💡 团队表现：本统计周期内暂无调用记录，快来开启与 AI 的协同吧！";
    } else if (userRankIdx === 0) {
      performanceTip = `💡 团队表现：🥇 荣登团队第 1 名（共 ${totalMembers} 人），断层领跑！继续保持卓越节奏！`;
    } else if (userRankIdx > 0 && totalMembers > 1) {
      const rank = userRankIdx + 1;
      const topPercent = Math.max(1, Math.round((rank / totalMembers) * 100));
      if (topPercent <= 50) {
        performanceTip = `💡 团队表现：位列团队前 ${topPercent}%（第 ${rank} 名 / 共 ${totalMembers} 人），已超越半数同事，表现亮眼！`;
      } else {
        performanceTip = `💡 团队表现：位列团队第 ${rank} 名（共 ${totalMembers} 人），持续探索 AI 协同，效能逐步释放！`;
      }
    } else {
      performanceTip = "💡 团队表现：AI 协同持续赋能中，继续保持！";
    }

    const deptStr = identity.department_label ? `（${identity.department_label}）` : "";
    return [
      `${permissionNotice}📊 【仟流智算 · 个人用量统计】`,
      `👤 姓名：${identity.person_name}${deptStr}`,
      `⏱ 统计周期：${intent.periodLabel} (${timeRangeStr})`,
      "━━━━━━━━━━━━━━━━━━",
      `🔹 Token 消耗总量：${formatTokenVolume(realTokens, { showTokensWord: true })}`,
      `   • 输入消耗：${formatTokenVolume(inputTokens)}`,
      `   • 输出消耗：${formatTokenVolume(outputTokens)}`,
      `   • 缓存命中：${formatTokenVolume(cacheTokens, { showTokensWord: true })}`,
      `🔹 发起调用次数：${formatNumber(requestCount)} 次`,
      `🔹 主力协同模型：${modelStr}`,
      "━━━━━━━━━━━━━━━━━━",
      performanceTip,
      "💬 您可随时发送“今天”、“昨天”、“本周”、“上一周”、“本月”快速查询。",
    ].join("\n");
  } catch (err: unknown) {
    console.error("[wecom-message] 处理企微消息异常:",
      err instanceof Error ? err.message : String(err));
    return [
      "⚠️ 【用量统计查询遇到问题】",
      `抱歉，在获取${intent.periodLabel}用量数据时出现异常，请稍后重试或联系系统管理员。`,
    ].join("\n");
  }
}

