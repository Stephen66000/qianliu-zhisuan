/**
 * W20 路由过程下钻的展示区块 —— 结算汇总 / 上游尝试 / 计价决策（自 RequestDrilldown.tsx 拆出）。
 * 字体三级收敛 + 颜色纪律；区块只做声明式展示（加载/空态/明细），
 * 取数与编排（四个异步结果、失败横幅、调度决策、技术详情）仍由 RequestDrilldown 主组件驱动。
 */
import type { RequestShapeSummary } from "@qianliu/contracts";
import type { UseQueryResult } from "@tanstack/react-query";
import { LoadingState } from "../components/states/LoadingState";
import { StatusTag } from "../components/dashboard/StatusTag";
import { formatCount, formatDateTimeFull, formatDecimal, formatDuration } from "../lib/format";
import { costMoneyExactText, costMoneyText, unavailableUsageCostLabel } from "../lib/usage-cost";
import type { AttemptsResult, DispatchDecisionItem, GatewayRequestDetail } from "../api/types";

interface SettlementSummaryProps {
  settlement: GatewayRequestDetail["settlement"];
  errorCode: string | null;
}

/** 结算汇总：本次请求的 token / 扣减 / API 费用与结算状态；无结算时按错误码区分空态文案。 */
export function SettlementSummary({ settlement, errorCode }: SettlementSummaryProps) {
  return (
    <section>
      {/* 结算汇总 */}
      <h3 className="text-[13px] font-semibold leading-5 text-ql-fg">结算汇总</h3>
      {settlement ? (
        <div className="mt-2 grid grid-cols-2 gap-x-6 gap-y-1 text-[13px] leading-5 sm:grid-cols-4">
          <Field label="输入 Token" value={formatCount(settlement.totalInputTokens)} />
          <Field label="输出 Token" value={formatCount(settlement.totalOutputTokens)} />
          <Field label="缓存 Token" value={formatCount(settlement.totalCacheTokens)} />
          <Field label="扣减额度" value={formatCount(settlement.totalDeductedQuota)} />
          <Field
            label="API费用估算"
            value={
              unavailableUsageCostLabel(settlement.totalApiCost, settlement.apiCostStatus)
                ?? (settlement.totalApiCost === "0" || settlement.totalApiCost === "0.00000000"
                  ? "套餐内"
                  : settlement.apiCostCurrency
                    // D-1（2026-11-04 走查裁定）：详情下钻按精确金额展示（验收计划 §3
                    // "小额非零估算应能从详情查明"），不再经 formatMoney 两位舍入；
                    // 列表页两位舍入展示不变。无币种处置投影仍为中性无符号（S2B/R8）。
                    ? costMoneyExactText(settlement.totalApiCost!, settlement.apiCostCurrency)
                    // S2B（R8 裁定）：结算级币种缺失（无处置投影或混币 NULL）时不渲染 ¥，
                    // 中性无符号展示——行级币种仍走快照冻结币种，costMoneyText 默认行为不变。
                    : formatDecimal(settlement.totalApiCost!, 8))
            }
          />
          <Field label="Attempt 数" value={String(settlement.attemptCount)} />
          <Field label="结算状态" value={settlement.status} />
        </div>
      ) : (
        <p className="mt-2 text-[13px] text-ql-fg-tertiary">
          {errorCode === "dispatch_rejected"
            ? "高峰时段暂停使用；Attempt 0 · 无 Usage · 无额度扣减 · 无 API 费用"
            : "无结算记录"}
        </p>
      )}
    </section>
  );
}

interface UpstreamAttemptsProps {
  attempts: UseQueryResult<AttemptsResult, Error>;
}

/** 上游尝试（WT-11/12）：逐次 Attempt 的状态、上游拒绝证据与逐条计量明细。 */
export function UpstreamAttempts({ attempts }: UpstreamAttemptsProps) {
  return (
    <section>
      {/* 上游尝试（WT-11/12） */}
      <h3 className="text-[13px] font-semibold leading-5 text-ql-fg">上游尝试</h3>
      {attempts.isLoading ? (
        <LoadingState label="加载尝试…" />
      ) : (attempts.data?.attempts ?? []).length === 0 ? (
        <p className="mt-2 text-[13px] text-ql-fg-tertiary">无尝试记录</p>
      ) : (
        <div className="mt-2 flex flex-col gap-2">
          {(attempts.data?.attempts ?? []).map((a) => (
            <div
              className="rounded-lg border border-ql-border-zone bg-ql-surface px-3 py-2"
              key={a.attemptNo}
            >
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                <span className="text-[13px] font-semibold text-ql-fg">#{a.attemptNo}</span>
                <span className="text-[13px] text-ql-fg-secondary">{a.upstreamModel}</span>
                {a.httpStatus !== null ? (
                  <StatusTag tone={a.httpStatus >= 400 ? "danger" : "neutral"}>
                    HTTP {a.httpStatus}
                  </StatusTag>
                ) : null}
                {a.responseCommitted ? <StatusTag tone="neutral">流式已提交</StatusTag> : null}
                {a.switchReason ? (
                  <span className="text-[13px] text-ql-fg-tertiary">切换：{a.switchReason}</span>
                ) : null}
                {a.errorClassification ? (
                  <StatusTag tone="warning">{a.errorClassification}</StatusTag>
                ) : null}
                {a.failureLayer ? (
                  <span className="text-[13px] text-ql-fg-tertiary">故障层：{a.failureLayer}</span>
                ) : null}
                {a.firstByteAt ? (
                  <span className="text-[13px] text-ql-fg-tertiary">
                    首字节 {formatDuration(new Date(a.firstByteAt).getTime() - new Date(a.startedAt).getTime())}
                  </span>
                ) : null}
                <span className="ml-auto text-[13px] text-ql-fg-tertiary">
                  {a.finishedAt
                    ? formatDuration(new Date(a.finishedAt).getTime() - new Date(a.startedAt).getTime())
                    : "进行中"}
                </span>
              </div>
              {a.upstreamErrorEvidence ? (
                <div className="mt-1.5 rounded-md bg-ql-danger-soft px-2.5 py-2 text-[13px] leading-[18px] text-ql-fg-secondary">
                  <span className="font-medium text-ql-danger">上游拒绝：{diagnosticCategory(a.upstreamErrorEvidence.messageCategory)}</span>
                  {a.upstreamErrorEvidence.type ? ` · type ${a.upstreamErrorEvidence.type}` : ""}
                  {a.upstreamErrorEvidence.code ? ` · code ${a.upstreamErrorEvidence.code}` : ""}
                  {a.upstreamErrorEvidence.param ? ` · 字段 ${a.upstreamErrorEvidence.param}` : ""}
                  {` · 诊断 ${a.upstreamErrorEvidence.diagnosticHash.slice(0, 12)}`}
                  {a.requestShapeSummary ? (
                    <span className="mt-1 block text-ql-fg-tertiary">
                      {requestShapeText(a.requestShapeSummary)}
                    </span>
                  ) : null}
                </div>
              ) : null}
              {/* P1-04：该 Attempt 的逐条计量明细（token/扣减/费用/计量质量） */}
              {a.metering.length > 0 ? (
                <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-0.5 border-t border-ql-border-zone pt-1.5">
                  {a.metering.map((m, i) => (
                    <span
                      className="text-[13px] leading-[18px] text-ql-fg-tertiary [font-variant-numeric:tabular-nums]"
                      key={i}
                    >
                      输入 {m.inputTokens} · 输出 {m.outputTokens} · 缓存 {m.cacheTokens}
                      {m.reasoningTokens !== "0" ? ` · 推理 ${m.reasoningTokens}` : ""}
                      {m.deductedQuota !== null ? ` · 扣减 ${m.deductedQuota}` : ""}
                      {m.apiCost !== null && m.apiCost !== "0" && m.apiCost !== "0.00000000"
                        ? ` · 估算 ${costMoneyText(m.apiCost, m.billingRuleSnapshot?.currency)}${priceBasisSuffix(m.billingRuleSnapshot)}`
                        : m.apiCostStatus === "EXCLUDED_NO_RECORDED_COST"
                          ? ` · ${unavailableUsageCostLabel(m.apiCost, m.apiCostStatus)}`
                          : " · 套餐内"}
                      {m.billingRuleSnapshot?.matchedWindow
                        ? ` · 命中时段 ${m.billingRuleSnapshot.matchedWindow.timezone} ${m.billingRuleSnapshot.matchedWindow.startTime}–${m.billingRuleSnapshot.matchedWindow.endTime}`
                        : m.billingRuleSnapshot?.startTime && m.billingRuleSnapshot?.endTime
                          ? ` · 时段 ${m.billingRuleSnapshot.timezone ?? ""} ${m.billingRuleSnapshot.startTime}–${m.billingRuleSnapshot.endTime}`
                          : ""}
                      {m.ruleVersion ? ` · 规则 ${m.ruleVersion}` : ""}
                      {m.multiplier ? ` · 倍率 ×${m.multiplier}` : ""}
                      {m.billingRuleSnapshot?.cacheMissPrice || m.billingRuleSnapshot?.outputPrice
                        ? ` · 单价 命中/输入/输出 ${m.billingRuleSnapshot.cacheHitPrice ?? "—"}/${m.billingRuleSnapshot.cacheMissPrice ?? "—"}/${m.billingRuleSnapshot.outputPrice ?? "—"}`
                        : ""}
                    </span>
                  ))}
                </div>
              ) : null}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

interface PricingDecisionsProps {
  attempts: UseQueryResult<AttemptsResult, Error>;
  dispatch: DispatchDecisionItem | null;
}

/** 计价决策：按 Attempt × 计量行展开冻结的计价快照证据。 */
export function PricingDecisions({ attempts, dispatch }: PricingDecisionsProps) {
  return (
    <section className="min-w-0">
      <h3 className="text-[13px] font-semibold leading-5 text-ql-fg">计价决策</h3>
      {attempts.isLoading ? (
        <LoadingState label="加载计价证据…" />
      ) : dispatch?.finalAction === "REJECT" && (attempts.data?.ledgerLines ?? []).length === 0 ? (
        <p className="mt-2 rounded-lg bg-ql-surface-muted p-3 text-[13px] text-ql-fg-secondary">
          调度已拒绝，请求未进入上游和计价：Attempt=0，无 Usage、无扣减、无费用。
        </p>
      ) : (attempts.data?.ledgerLines ?? []).length === 0 ? (
        <p className="mt-2 text-[13px] text-ql-fg-tertiary">无计价决策记录</p>
      ) : (
        <div className="mt-2 grid min-w-0 grid-cols-1 gap-2 lg:grid-cols-2">
          {(attempts.data?.attempts ?? []).flatMap((attempt) =>
            attempt.metering.map((metering, index) => {
              const snapshot = metering.billingRuleSnapshot;
              // D-1（2026-11-04 走查）：账本行缺 billing_rule_snapshot 单价（旧数据/
              // 合成种子）时，回退展示 control-api /attempts 透出的 billingPrices
              // （快照单价优先、缺失回退 billing_rule 并注明来源）——单价三列
              // （缓存/输入/输出）不再显示"—"。快照含单价时仍以快照为准。
              const prices = snapshot?.cacheHitPrice || snapshot?.cacheMissPrice || snapshot?.outputPrice
                ? `${snapshot.cacheHitPrice ?? "—"} / ${snapshot.cacheMissPrice ?? "—"} / ${snapshot.outputPrice ?? "—"}`
                : metering.billingPrices
                  ? `${metering.billingPrices.cacheHitPrice ?? "—"} / ${metering.billingPrices.cacheMissPrice ?? "—"} / ${metering.billingPrices.outputPrice ?? "—"}`
                  : "—";
              return (
                <div className="min-w-0 rounded-lg border border-ql-border-zone bg-ql-surface p-3" key={`${attempt.attemptNo}-${index}`}>
                  <div className="grid min-w-0 grid-cols-1 gap-x-5 gap-y-1 text-[13px] sm:grid-cols-2">
                    <Field label="规则版本" value={metering.ruleVersion ?? "未命中"} />
                    <Field label="规则类型" value={snapshot?.ruleType ?? "—"} />
                    <Field label="模型 / 资源" value={`${attempt.upstreamModel} / ${attempt.providerResourceId}`} />
                    <Field label="生效时间" value={snapshot?.effectiveFrom ? formatDateTimeFull(snapshot.effectiveFrom) : "—"} />
                    <Field label="单价（缓存/输入/输出）" value={prices} />
                    <Field label="倍率" value={metering.multiplier ? `×${metering.multiplier}` : "—"} />
                    <Field label="估算费用" value={metering.apiCost !== null
                      ? `${costMoneyText(metering.apiCost, snapshot?.currency)}${priceBasisSuffix(snapshot)}`
                      : metering.apiCostStatus === "EXCLUDED_NO_RECORDED_COST"
                        ? unavailableUsageCostLabel(metering.apiCost, metering.apiCostStatus)! : "套餐内"} />
                  </div>
                </div>
              );
            }),
          )}
        </div>
      )}
    </section>
  );
}

/**
 * ACE-02 场景 3：UNVERIFIED 规则计价的金额必须呈现"价格依据待核实"。
 * 数据源＝结算时冻结在 ledger_line.billing_rule_snapshot 的 sourceStatus（gateway
 * billing.ts 随快照写入，gateway-requests 路由原样透出）；旧快照缺省按 UNVERIFIED 解释。
 */
function priceBasisSuffix(snapshot: { sourceStatus?: "VERIFIED" | "UNVERIFIED" } | null | undefined): string {
  return snapshot?.sourceStatus === "VERIFIED" ? "" : "（价格依据待核实）";
}

function diagnosticCategory(category: string): string {
  const labels: Record<string, string> = {
    AUTHENTICATION_FAILED: "凭证鉴权失败",
    CREDENTIAL_EXPIRED: "凭证已过期",
    CREDENTIAL_REVOKED: "凭证已撤销",
    PERMISSION_DENIED: "凭证权限不足",
    UNSUPPORTED_PARAMETER: "不支持的参数",
    INVALID_PARAMETER: "参数无效",
    INVALID_MESSAGE_CONTENT: "消息内容不兼容",
    INVALID_TOOL_SCHEMA: "工具 Schema 不兼容",
    CONTEXT_LENGTH_EXCEEDED: "超出上下文长度",
    MODEL_UNAVAILABLE: "模型不可用",
    MODEL_IMAGE_UNSUPPORTED: "模型不支持图片",
    UNCLASSIFIED: "未分类请求错误",
  };
  return labels[category] ?? "未分类请求错误";
}

function requestShapeText(shape: RequestShapeSummary): string {
  const unmatched = shape.unmatchedAssistantToolCallCount + shape.unmatchedToolResultCount;
  const issues = Object.entries(shape.toolSchemaIssueCounts)
    .filter(([, count]) => count > 0)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([issue, count]) => `${issue}:${count}`)
    .join("/");
  return [
    `结构：消息 ${shape.messageCount}`,
    `内容类型 ${shape.contentKinds.join("/") || "无"}`,
    `工具 ${shape.toolCount}（函数 ${shape.functionToolCount}／异常 ${shape.invalidToolCount}）`,
    `Schema 深度 ${shape.schemaMaxDepth}／节点 ${shape.schemaNodeCount}／属性 ${shape.schemaPropertyCount}`,
    shape.schemaKeywords.length > 0 ? `Schema 关键字 ${shape.schemaKeywords.join("/")}` : "",
    shape.contentBlockTypes.length > 0 ? `内容块 ${shape.contentBlockTypes.join("/")}` : "",
    `未配对工具事件 ${unmatched}`,
    issues ? `Schema 问题 ${issues}` : "",
    shape.countOverflowed ? "计数已达安全上限" : "",
  ].filter(Boolean).join(" · ");
}

export function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-w-0 items-start justify-between gap-2">
      <span className="shrink-0 text-[13px] text-ql-fg-tertiary">{label}</span>
      <span className="min-w-0 break-words text-right [font-variant-numeric:tabular-nums] text-ql-fg">{value}</span>
    </div>
  );
}
