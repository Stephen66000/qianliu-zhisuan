/**
 * W20 路由过程下钻 —— 候选 / Attempt / 调度决策（PRD §10.3 可展开"路由过程"）。
 *
 * 字体三级收敛 + 颜色纪律；内部快照默认摘要展示，原始调度输入按需展开。
 */
import type { RequestShapeSummary } from "@qianliu/contracts";
import {
  useAttempts,
  useDispatchDecision,
  useGatewayRequest,
  useRouteCandidates,
} from "../api/hooks";
import { LoadingState } from "../components/states/LoadingState";
import { ErrorState } from "../components/states/ErrorState";
import { StatusTag } from "../components/dashboard/StatusTag";
import { formatCount, formatDateTimeFull, formatDuration, formatMoney } from "../lib/format";

interface RequestDrilldownProps {
  requestId: string;
}

// eslint-disable-next-line complexity -- 下钻页按四类独立异步结果分别呈现加载、空态与明细，分支均为声明式展示。
export function RequestDrilldown({ requestId }: RequestDrilldownProps) {
  const detail = useGatewayRequest(requestId);
  const candidates = useRouteCandidates(requestId);
  const attempts = useAttempts(requestId);
  const decision = useDispatchDecision(requestId);

  if (detail.isLoading) {
    return <LoadingState label="正在加载路由过程…" />;
  }
  if (detail.error || !detail.data) {
    return (
      <ErrorState
        message={detail.error?.message ?? "请求明细加载失败"}
        onRetry={() => void detail.refetch()}
      />
    );
  }

  const { request, settlement } = detail.data;
  const routeCandidates = candidates.data?.candidates ?? [];
  const dispatch = decision.data?.decision ?? null;
  const technicalJson = dispatch?.dispatchInput
    ? JSON.stringify(dispatch.dispatchInput, null, 2)
    : null;

  return (
    <div className="flex flex-col gap-4 rounded-xl border border-ql-border bg-ql-surface-subtle p-4">
      {/* 结算汇总 */}
      <section>
        <h3 className="text-[13px] font-semibold leading-5 text-ql-fg">结算汇总</h3>
        {settlement ? (
          <div className="mt-2 grid grid-cols-2 gap-x-6 gap-y-1 text-[13px] leading-5 sm:grid-cols-4">
            <Field label="输入 Token" value={formatCount(settlement.totalInputTokens)} />
            <Field label="输出 Token" value={formatCount(settlement.totalOutputTokens)} />
            <Field label="缓存 Token" value={formatCount(settlement.totalCacheTokens)} />
            <Field label="扣减额度" value={formatCount(settlement.totalDeductedQuota)} />
            <Field
              label="API 费用（元）"
              value={
                settlement.totalApiCost === "0" || settlement.totalApiCost === "0.00000000"
                  ? "套餐内"
                  : formatMoney(settlement.totalApiCost)
              }
            />
            <Field label="计量质量" value={settlement.usageQuality} />
            <Field label="Attempt 数" value={String(settlement.attemptCount)} />
            <Field label="结算状态" value={settlement.status} />
          </div>
        ) : (
          <p className="mt-2 text-[13px] text-ql-fg-tertiary">
            {request.errorCode === "dispatch_rejected"
              ? "高峰时段暂停使用；Attempt 0 · 无 Usage · 无额度扣减 · 无 API 费用"
              : "无结算记录"}
          </p>
        )}
      </section>

      {/* 路由候选（WT-10/18） */}
      <section>
        <h3 className="text-[13px] font-semibold leading-5 text-ql-fg">路由候选</h3>
        {candidates.isLoading ? (
          <LoadingState label="加载候选…" />
        ) : (candidates.data?.candidates ?? []).length === 0 ? (
          <p className="mt-2 text-[13px] text-ql-fg-tertiary">无候选记录</p>
        ) : (
          <div className="mt-2 overflow-x-auto">
            <table className="w-full border-collapse text-left">
              <thead>
                <tr className="border-b border-ql-border text-[12px] leading-[18px] text-ql-fg-tertiary">
                  <th className="py-1.5 pr-4 font-medium">上游模型</th>
                  <th className="py-1.5 pr-4 text-right font-medium">优先级</th>
                  <th className="py-1.5 pr-4 text-right font-medium">权重</th>
                  <th className="py-1.5 pr-4 text-right font-medium">总分</th>
                  <th className="py-1.5 pr-4 font-medium">评分因子</th>
                  <th className="py-1.5 font-medium">结果</th>
                </tr>
              </thead>
              <tbody>
                {(candidates.data?.candidates ?? []).map((c, i) => (
                  <tr
                    className="border-b border-ql-border-zone text-[13px] leading-5 text-ql-fg last:border-b-0"
                    key={i}
                  >
                    <td className="py-2 pr-4 font-medium">{c.upstreamModel}</td>
                    <td className="py-2 pr-4 text-right [font-variant-numeric:tabular-nums]">{c.priority}</td>
                    <td className="py-2 pr-4 text-right [font-variant-numeric:tabular-nums]">{c.weight}</td>
                    <td className="py-2 pr-4 text-right [font-variant-numeric:tabular-nums]">{c.totalScore ?? "—"}</td>
                    <td className="py-2 pr-4 font-mono text-[12px] text-ql-fg-tertiary">
                      {c.scoreFactors ? JSON.stringify(c.scoreFactors) : "—"}
                    </td>
                    <td className="py-2">
                      {c.selected ? (
                        <StatusTag tone="success">选中</StatusTag>
                      ) : (
                        <StatusTag tone="neutral">{c.reasonCode ?? "未选中"}</StatusTag>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* 上游尝试（WT-11/12） */}
      <section>
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
                    <span className="text-[12px] text-ql-fg-tertiary">切换：{a.switchReason}</span>
                  ) : null}
                  {a.errorClassification ? (
                    <StatusTag tone="warning">{a.errorClassification}</StatusTag>
                  ) : null}
                  {a.failureLayer ? (
                    <span className="text-[12px] text-ql-fg-tertiary">故障层：{a.failureLayer}</span>
                  ) : null}
                  {a.firstByteAt ? (
                    <span className="text-[12px] text-ql-fg-tertiary">
                      首字节 {formatDuration(new Date(a.firstByteAt).getTime() - new Date(a.startedAt).getTime())}
                    </span>
                  ) : null}
                  <span className="ml-auto text-[12px] text-ql-fg-tertiary">
                    {a.finishedAt
                      ? formatDuration(new Date(a.finishedAt).getTime() - new Date(a.startedAt).getTime())
                      : "进行中"}
                  </span>
                </div>
                {a.upstreamErrorEvidence ? (
                  <div className="mt-1.5 rounded-md bg-ql-danger-soft px-2.5 py-2 text-[12px] leading-[18px] text-ql-fg-secondary">
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
                        className="text-[12px] leading-[18px] text-ql-fg-tertiary [font-variant-numeric:tabular-nums]"
                        key={i}
                      >
                        输入 {m.inputTokens} · 输出 {m.outputTokens} · 缓存 {m.cacheTokens}
                        {m.reasoningTokens !== "0" ? ` · 推理 ${m.reasoningTokens}` : ""}
                        {m.deductedQuota !== null ? ` · 扣减 ${m.deductedQuota}` : ""}
                        {m.apiCost !== null && m.apiCost !== "0" && m.apiCost !== "0.00000000"
                          ? ` · 费用 ${formatMoney(m.apiCost)} 元`
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
                        {m.usageQuality ? ` · ${m.usageQuality}` : ""}
                      </span>
                    ))}
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </section>

      {/* 计价决策与调度决策分区；这里只展示请求时点冻结的账本快照。 */}
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
                const prices = snapshot?.cacheHitPrice || snapshot?.cacheMissPrice || snapshot?.outputPrice
                  ? `${snapshot.cacheHitPrice ?? "—"} / ${snapshot.cacheMissPrice ?? "—"} / ${snapshot.outputPrice ?? "—"}`
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
                      <Field label="计量质量" value={metering.usageQuality} />
                      <Field label="最终费用" value={metering.apiCost === null ? "套餐内" : `${formatMoney(metering.apiCost)} 元`} />
                    </div>
                  </div>
                );
              }),
            )}
          </div>
        )}
      </section>

      {/* 调度决策（WT-16/17） */}
      <section className="min-w-0">
        <h3 className="text-[13px] font-semibold leading-5 text-ql-fg">调度决策</h3>
        {decision.isLoading ? (
          <LoadingState label="加载决策…" />
        ) : !decision.data?.decision ? (
          <p className="mt-2 text-[13px] text-ql-fg-tertiary">无调度决策记录</p>
        ) : (
          <div className="mt-2 min-w-0">
            <p className="mb-2 rounded-lg bg-ql-surface-muted p-3 text-[13px] text-ql-fg-secondary">
              {dispatch?.reasonCode === "ALLOW_NO_POLICY" || !dispatch?.matchedPolicyId
                ? "未命中调度策略，默认允许"
                : dispatch?.reasonDetail ?? `命中调度策略 ${dispatch?.matchedPolicyVersion ?? dispatch?.matchedPolicyId}`}
            </p>
            <div className="grid min-w-0 grid-cols-1 gap-x-6 gap-y-1 text-[13px] leading-5 sm:grid-cols-2 lg:grid-cols-3">
            <Field label="最终动作" value={decision.data.decision.finalAction} />
            <Field label="理由码" value={decision.data.decision.reasonCode} />
            <Field
              label="命中策略"
              value={
                decision.data.decision.matchedPolicyVersion ??
                decision.data.decision.matchedPolicyId ??
                "未命中"
              }
            />
            <Field
              label="策略动作"
              value={decision.data.decision.matchedPolicyAction ?? "—"}
            />
            {decision.data.decision.finalAction === "REJECT" ? <>
              <Field label="策略时段" value={String(decision.data.decision.dispatchInput?.policyWindow ?? "未知")} />
              <Field label="重置时间" value={String(decision.data.decision.dispatchInput?.policyResetAt ?? "未知")} />
            </> : null}
            <Field
              label="选中资源"
              value={String(decision.data.decision.dispatchInput?.selectedResourceId ?? "—")}
            />
            <Field label="候选数量" value={String(routeCandidates.length)} />
            <Field
              label="是否切换"
              value={decision.data.decision.switchTargetResourceId ? `是 → ${decision.data.decision.switchTargetResourceId}` : "否"}
            />
            <Field
              label="节省"
              value={
                decision.data.decision.savingCalculable
                  ? decision.data.decision.dispatchSaving
                    ? `${formatMoney(decision.data.decision.dispatchSaving)} 元`
                    : "—"
                  : `不可计算${decision.data.decision.notCalculableReason ? `（${decision.data.decision.notCalculableReason}）` : ""}`
              }
            />
            <Field
              label="反事实成本"
              value={decision.data.decision.counterfactualCost
                ? `${formatMoney(decision.data.decision.counterfactualCost)} 元`
                : "—"}
            />
            <Field
              label="实际成本"
              value={decision.data.decision.actualCost
                ? `${formatMoney(decision.data.decision.actualCost)} 元`
                : "—"}
            />
            </div>
            {technicalJson ? (
              <details className="mt-3 min-w-0 rounded-lg border border-ql-border-zone bg-ql-surface">
                <summary className="cursor-pointer px-3 py-2 text-[12px] font-medium text-ql-fg-secondary">
                  技术详情（调度输入快照）
                </summary>
                <div className="min-w-0 border-t border-ql-border-zone p-3">
                  <div className="mb-2 flex justify-end">
                    <button
                      className="rounded px-2 py-1 text-[12px] text-ql-action hover:bg-ql-action-soft"
                      onClick={() => void navigator.clipboard?.writeText(technicalJson)}
                      type="button"
                    >
                      复制技术详情
                    </button>
                  </div>
                  <pre className="max-w-full whitespace-pre-wrap break-all font-mono text-[12px] leading-5 text-ql-fg-secondary">
                    {technicalJson}
                  </pre>
                </div>
              </details>
            ) : null}
          </div>
        )}
      </section>

      <p className="text-[12px] leading-[18px] text-ql-fg-tertiary">
        请求 {request.id} · 开始于 {formatDateTimeFull(request.startedAt)}
      </p>
    </div>
  );
}

function diagnosticCategory(category: string): string {
  const labels: Record<string, string> = {
    UNSUPPORTED_PARAMETER: "不支持的参数",
    INVALID_PARAMETER: "参数无效",
    INVALID_MESSAGE_CONTENT: "消息内容不兼容",
    INVALID_TOOL_SCHEMA: "工具 Schema 不兼容",
    CONTEXT_LENGTH_EXCEEDED: "超出上下文长度",
    MODEL_UNAVAILABLE: "模型不可用",
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
    `未配对工具事件 ${unmatched}`,
    issues ? `Schema 问题 ${issues}` : "",
    shape.countOverflowed ? "计数已达安全上限" : "",
  ].filter(Boolean).join(" · ");
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-w-0 items-start justify-between gap-2">
      <span className="shrink-0 text-[12px] text-ql-fg-tertiary">{label}</span>
      <span className="min-w-0 break-words text-right [font-variant-numeric:tabular-nums] text-ql-fg">{value}</span>
    </div>
  );
}
