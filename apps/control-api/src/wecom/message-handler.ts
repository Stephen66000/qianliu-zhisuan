import type { Kysely } from "kysely";
import type { Database } from "@qianliu/database";
import { UsageOverviewRepository } from "@qianliu/database";
import { parseQueryIntent, type ParsedIntent } from "./intent-parser.js";

function formatNumber(num: number | string | bigint): string {
  const n = typeof num === "bigint" ? Number(num) : typeof num === "string" ? Number(num) : num;
  if (!Number.isFinite(n)) return "0";
  return n.toLocaleString("zh-CN");
}

function formatDateRange(fromIso: string, toIso: string, timezone: string): string {
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

/**
 * 微信自建应用交互消息处理器。
 * 返回需要给用户回复的纯文本消息内容。
 */
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
      "• 「上一周我用了多少token」",
      "• 「本周用量」",
      "• 「本月用量」",
      "",
      "💡 发送后将即时为您统计并汇总对应周期的 Token 消耗明细。",
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
    const overview = await usageRepo.getOverview({
      enterpriseId: identity.enterprise_id,
      subjectType: "EMPLOYEE",
      subjectId: actualScope === "SELF" ? principal.id : undefined,
      period: intent.overviewPeriod,
      anchor: intent.anchor,
    });

    const metrics = overview.metrics;
    const timeRangeStr = formatDateRange(overview.range.from, overview.range.to, overview.timezone);

    if (actualScope === "TEAM") {
      const topRanking = overview.ranking.slice(0, 5);
      const rankingLines = topRanking.length > 0
        ? [
            "",
            "🏆 【成员消耗 Top 5】:",
            ...topRanking.map(
              (item, idx) =>
                ` ${idx + 1}. ${item.subjectName}${item.departmentLabel ? ` (${item.departmentLabel})` : ""}: ${formatNumber(item.realTokens)} tokens (${item.share})`,
            ),
          ]
        : ["", "暂无成员用量排行数据"];

      return [
        "🏢 【仟流智算 · 全员用量统计】",
        `⏱ 统计周期：${intent.periodLabel} (${timeRangeStr})`,
        "━━━━━━━━━━━━━━━━━━",
        `🔹 全员总消耗：${formatNumber(metrics.realTokens)} Tokens`,
        `   • 输入 Tokens：${formatNumber(metrics.inputTokens)}`,
        `   • 输出 Tokens：${formatNumber(metrics.outputTokens)}`,
        `   • 缓存命中：${formatNumber(metrics.cacheTokens)} Tokens`,
        `🔹 请求调用次数：${formatNumber(metrics.requestCount)} 次`,
        `🔹 活跃员工数：${metrics.activeSubjects} 人`,
        ...rankingLines,
        "━━━━━━━━━━━━━━━━━━",
        "💡 提示：可随时发送“今天”、“昨天”、“本周”、“上周”、“本月”快速查询。",
      ].join("\n");
    }

    // 个人用量回复
    const deptStr = identity.department_label ? `（${identity.department_label}）` : "";
    return [
      `${permissionNotice}📊 【仟流智算 · 个人用量统计】`,
      `👤 姓名：${identity.person_name}${deptStr}`,
      `⏱ 统计周期：${intent.periodLabel} (${timeRangeStr})`,
      "━━━━━━━━━━━━━━━━━━",
      `🔹 总 Token 消耗：${formatNumber(metrics.realTokens)} Tokens`,
      `   • 输入 Tokens：${formatNumber(metrics.inputTokens)}`,
      `   • 输出 Tokens：${formatNumber(metrics.outputTokens)}`,
      `   • 缓存命中：${formatNumber(metrics.cacheTokens)} Tokens`,
      `🔹 请求调用次数：${formatNumber(metrics.requestCount)} 次`,
      "━━━━━━━━━━━━━━━━━━",
      "💡 提示：您可以随时向我发送“昨天”、“本周”、“上一周”、“本月”快速查询。",
    ].join("\n");
  } catch {
    return [
      "⚠️ 【用量统计查询遇到问题】",
      `抱歉，在获取${intent.periodLabel}用量数据时出现异常，请稍后重试或联系系统管理员。`,
    ].join("\n");
  }
}
