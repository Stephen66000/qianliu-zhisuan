/**
 * 标准版首页资源区聚合（HOME-STANDARD-20260910 WP02）—— 按厂商分组。
 *
 * 调用状态与额度/余额同步状态分别判断：同步成功不冒充调用恢复，同步失败不抹掉
 * 已知调用正常；健康数据缺失（未执行/过期）不冒充正常。状态中文标签镜像
 * apps/control-api/src/providers/health-routes.ts（判定语义源在 control-api）。
 */
import { worstResourceStatus, type ResourceStatus } from "@qianliu/domain";
import type { Kysely } from "kysely";
import { sql } from "kysely";
import type { Database } from "../kysely.js";
import { ProviderRepository } from "./provider-repository.js";
import type { ProviderOperatingSyncState } from "./provider-operating-repository.js";
import type {
  ProviderStatusCategory,
  StandardHomeProviderRow,
  StandardHomeResources,
} from "./dashboard-home-types.js";

/** 与 providers/routes.ts 一致的经营数据过期阈值。 */
const SYNC_STALE_MS = 36 * 3_600_000;

/** 状态中文标签；镜像 apps/control-api/src/providers/health-routes.ts STATUS_LABEL。 */
const RESOURCE_STATUS_LABEL: Record<string, string> = {
  ACTIVE: "正常",
  DEGRADED: "降级（仍可使用）",
  EXHAUSTED: "额度耗尽",
  EXPIRED: "凭证过期",
  CREDENTIAL_INVALID: "凭证失效",
  RATE_LIMITED: "限流冷却",
  UNAVAILABLE: "不可用",
};

function resourceStatusLabel(status: string, mode: string, reason: string | null): string {
  if (status === "DEGRADED" && reason === "QUOTA_SYNC_RECOVERED") return "额度已恢复，待调用确认";
  if (status === "DEGRADED" && reason === "BALANCE_SYNC_RECOVERED") return "余额已恢复，待调用确认";
  if (status === "EXHAUSTED") return mode === "API" ? "余额不足" : "套餐额度耗尽";
  return RESOURCE_STATUS_LABEL[status] ?? status;
}

interface ProviderResourceStatusRow {
  provider_code: string;
  provider_name: string;
  resource_id: string;
  resource_name: string;
  mode: string;
  status: string;
  updated_at: Date;
}

interface LatestStatusEventRow {
  provider_resource_id: string;
  reason: string;
  time_reliable: boolean;
}

interface AbnormalResourceView {
  resourceName: string;
  status: string;
  mode: string;
  label: string;
}

/** 逐资源同步事实（R01-F03）：任一资源失败/缺失/过期都不得被其他资源的新鲜同步掩盖。 */
interface ResourceSyncFacts {
  failedCount: number;
  failedErrorCodes: string[];
  staleCount: number;
  notRunCount: number;
  resourceCount: number;
}

const RESOURCE_SEVERITY_ORDER = ["ACTIVE", "DEGRADED", "RATE_LIMITED", "UNAVAILABLE",
  "EXHAUSTED", "EXPIRED", "CREDENTIAL_INVALID"];

function resourceSeverity(status: string): number {
  const index = RESOURCE_SEVERITY_ORDER.indexOf(status);
  return index === -1 ? -1 : index;
}

function syncStateOf(
  sync: ProviderOperatingSyncState | undefined,
  now: Date,
): "FAILED" | "NOT_RUN" | "STALE" | "OK" {
  if (!sync) return "NOT_RUN";
  if (sync.balance_status === "FAILED" || sync.cost_status === "FAILED") return "FAILED";
  const lastSuccess = sync.last_success_data_at;
  if (!lastSuccess || now.getTime() - lastSuccess.getTime() > SYNC_STALE_MS) return "STALE";
  return "OK";
}

/** 一句话关注信息：固定模板从既有事实生成，不引入大模型，不含凭证或原始上游内容。 */
function attentionText(
  abnormal: AbnormalResourceView[],
  sync: ResourceSyncFacts,
): string | null {
  const parts: string[] = [];
  if (abnormal.length > 0) {
    const byLabel = new Map<string, number>();
    for (const item of abnormal) {
      byLabel.set(item.label, (byLabel.get(item.label) ?? 0) + 1);
    }
    const worst = abnormal.reduce((left, right) =>
      resourceSeverity(right.status) > resourceSeverity(left.status) ? right : left);
    // 不变量：abnormal.length === 1 时按构造必有唯一元素，非空断言安全（V14-C2 F-E）。
    const scope = abnormal.length === 1 ? abnormal[0]!.resourceName : `其中 ${abnormal.length} 项资源`;
    const summary = [...byLabel.entries()].map(([label, count]) =>
      count === 1 ? label : `${count} 项${label}`).join("、");
    const hint = worst.status === "CREDENTIAL_INVALID" || worst.status === "EXPIRED"
      ? "，需要更新凭证"
      : worst.status === "EXHAUSTED"
        ? worst.mode === "API" ? "，需充值后等待余额同步" : "，需补充套餐或等待额度重置"
        : worst.status === "RATE_LIMITED" || worst.status === "UNAVAILABLE"
          ? "，冷却到期后自动探测恢复"
          : "";
    parts.push(`${scope}：${summary}${hint}`);
  }
  if (sync.failedCount > 0) {
    const codes = sync.failedErrorCodes.length > 0 ? `（${sync.failedErrorCodes.join("、")}）` : "";
    parts.push(`其中 ${sync.failedCount} 项资源经营数据同步失败${codes}`);
  }
  if (sync.notRunCount > 0) {
    parts.push(`其中 ${sync.notRunCount} 项资源尚未执行经营数据同步`);
  }
  if (sync.staleCount > 0) {
    parts.push(`其中 ${sync.staleCount} 项资源经营数据同步超过 36 小时未成功`);
  }
  if (parts.length === 0) return null;
  const suffix = sync.failedCount + sync.notRunCount + sync.staleCount > 0
    ? "；额度与余额情况需分别确认" : "";
  return `${parts.join("；")}${suffix}`;
}

function providerRow(
  rows: ProviderResourceStatusRow[],
  reasonByResource: Map<string, LatestStatusEventRow>,
  syncByResource: Map<string, ProviderOperatingSyncState>,
  now: Date,
): StandardHomeProviderRow {
  // 不变量：providerRow 仅被按厂商非空分组调用（byProvider 构造保证 rows.length ≥ 1，
  // 见 loadStandardHomeResources 的分组循环），首元素非空断言安全（V14-C2 F-E）。
  const [providerName, providerCode] = [rows[0]!.provider_name, rows[0]!.provider_code];
  const abnormal = rows
    .filter((row) => row.status !== "ACTIVE")
    .map((row) => {
      const event = reasonByResource.get(row.resource_id);
      return {
        resourceName: row.resource_name,
        status: row.status,
        mode: row.mode,
        label: resourceStatusLabel(
          row.status, row.mode, event && event.time_reliable ? event.reason : null),
      };
    });
  const worstRow = rows.reduce((left, right) =>
    resourceSeverity(right.status) > resourceSeverity(left.status) ? right : left);
  const worstEvent = reasonByResource.get(worstRow.resource_id);
  const worst = worstResourceStatus(rows.map((row) => row.status as ResourceStatus));
  // R01-F03：逐资源判定同步状态后聚合，任一项失败/缺失/过期都会暴露并给出范围。
  const perResource = rows.map((row) => {
    const sync = syncByResource.get(row.resource_id);
    return { state: syncStateOf(sync, now), sync };
  });
  const failedCodes = new Set<string>();
  for (const item of perResource) {
    if (item.state === "FAILED" && item.sync?.error_code) failedCodes.add(item.sync.error_code);
  }
  const syncFacts: ResourceSyncFacts = {
    failedCount: perResource.filter((item) => item.state === "FAILED").length,
    failedErrorCodes: [...failedCodes],
    staleCount: perResource.filter((item) => item.state === "STALE").length,
    notRunCount: perResource.filter((item) => item.state === "NOT_RUN").length,
    resourceCount: rows.length,
  };
  const lastSyncAt = rows.reduce<Date | null>((latest, row) => {
    const completed = syncByResource.get(row.resource_id)?.completed_at;
    return completed && (!latest || completed > latest) ? completed : latest;
  }, null);
  const worstReason = worstEvent && worstEvent.time_reliable ? worstEvent.reason : null;
  const pendingConfirm = worst === "DEGRADED"
    && (worstReason === "QUOTA_SYNC_RECOVERED" || worstReason === "BALANCE_SYNC_RECOVERED");
  const statusCategory: ProviderStatusCategory = worst === "ACTIVE" ? "NORMAL"
    : pendingConfirm ? "PENDING_CONFIRM"
      : rows.some((row) => row.status === "ACTIVE") ? "PARTIAL_ABNORMAL" : "ABNORMAL";
  const modeCounts = new Map<string, number>();
  for (const row of rows) {
    modeCounts.set(row.mode, (modeCounts.get(row.mode) ?? 0) + 1);
  }
  return {
    providerCode,
    providerName,
    resourceCount: rows.length,
    modes: [...modeCounts.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([mode, count]) => ({ mode: mode as "API" | "CODING_PLAN", count })),
    worstStatus: worst,
    statusLabel: worst === "ACTIVE"
      ? "正常"
      : resourceStatusLabel(worst, worstRow.mode, worstReason),
    statusCategory,
    abnormalResourceCount: abnormal.length,
    attention: attentionText(abnormal, syncFacts),
    syncFailed: syncFacts.failedCount > 0,
    syncStale: syncFacts.staleCount > 0 || syncFacts.notRunCount > 0,
    lastSyncAt: lastSyncAt?.toISOString() ?? null,
  };
}

/** 接入资源区聚合：厂商清单来自真实数据，数量与形态不硬编码；正常厂商完整列出。 */
export async function loadStandardHomeResources(
  db: Kysely<Database>,
  enterpriseId: string,
  now: Date,
): Promise<StandardHomeResources> {
  const [resourceRows, syncStates] = await Promise.all([
    sql<ProviderResourceStatusRow>`
      SELECT p.code AS provider_code, p.name AS provider_name,
             pr.id AS resource_id, pr.name AS resource_name, pr.mode, pr.status,
             pr.updated_at
        FROM provider_resource pr
        JOIN provider p ON p.id = pr.provider_id AND p.enterprise_id = ${enterpriseId}
       WHERE pr.enterprise_id = ${enterpriseId} AND pr.status <> 'DELETED'
       ORDER BY p.name ASC, pr.name ASC
    `.execute(db),
    new ProviderRepository(db).listLatestOperatingSyncStates(enterpriseId),
  ]);
  const abnormalIds = resourceRows.rows
    .filter((row) => row.status !== "ACTIVE")
    .map((row) => row.resource_id);
  const eventRows = abnormalIds.length === 0 ? [] : (await sql<LatestStatusEventRow>`
      SELECT DISTINCT ON (provider_resource_id) provider_resource_id, reason, time_reliable
        FROM resource_status_event
       WHERE enterprise_id = ${enterpriseId}
         AND provider_resource_id IN (${sql.join(abnormalIds.map((id) => sql`${id}`), sql`, `)})
       ORDER BY provider_resource_id, created_at DESC
    `.execute(db)).rows;
  const reasonByResource = new Map(eventRows.map((row) => [row.provider_resource_id, row]));
  const syncByResource = new Map(syncStates.map((state) => [state.provider_resource_id, state]));

  const byProvider = new Map<string, ProviderResourceStatusRow[]>();
  for (const row of resourceRows.rows) {
    const key = `${row.provider_name}\u0000${row.provider_code}`;
    byProvider.set(key, [...(byProvider.get(key) ?? []), row]);
  }
  const providers = [...byProvider.values()]
    .map((rows) => providerRow(rows, reasonByResource, syncByResource, now))
    .sort((left, right) => left.providerName.localeCompare(right.providerName, "zh-Hans-CN"));

  const resourceUpdatedAt = [
    ...resourceRows.rows.map((row) => row.updated_at),
    ...syncStates.map((state) => state.completed_at),
  ].reduce<Date | null>((latest, value) => !latest || value > latest ? value : latest, null);
  return {
    providerCount: providers.length,
    resourceCount: resourceRows.rows.length,
    // 语义决策（V14-C2 F-F，待产品复核）：未执行/过期/失败的同步均按既有 STALE 语义计入
    // "需关注"，与 apps/control-api providers/routes.ts 的 SYNC_NOT_RUN→STALE 判定一致；
    // 是否过滤明确不支持同步（NOT_SUPPORTED）的资源属产品规则，裁决前保持现状。
    attentionProviderCount: providers.filter((provider) => provider.attention !== null).length,
    updatedAt: resourceUpdatedAt?.toISOString() ?? null,
    providers,
  };
}
