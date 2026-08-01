/**
 * W20 路由过程下钻 —— 候选 / Attempt / 调度决策（PRD §10.3 可展开"路由过程"）。
 *
 * 字体三级收敛 + 颜色纪律；score_factors / dispatch_input 原样展示（网关侧已脱敏）。
 */
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
          <p className="mt-2 text-[13px] text-ql-fg-tertiary">无结算记录</p>
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
                  <span className="ml-auto text-[12px] text-ql-fg-tertiary">
                    {a.finishedAt
                      ? formatDuration(new Date(a.finishedAt).getTime() - new Date(a.startedAt).getTime())
                      : "进行中"}
                  </span>
                </div>
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
                          ? ` · 费用 ${m.apiCost} 元`
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

      {/* 调度决策（WT-16/17） */}
      <section>
        <h3 className="text-[13px] font-semibold leading-5 text-ql-fg">调度决策</h3>
        {decision.isLoading ? (
          <LoadingState label="加载决策…" />
        ) : !decision.data?.decision ? (
          <p className="mt-2 text-[13px] text-ql-fg-tertiary">无调度决策记录</p>
        ) : (
          <div className="mt-2 grid grid-cols-2 gap-x-6 gap-y-1 text-[13px] leading-5 sm:grid-cols-3">
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
            <Field
              label="调度输入"
              value={
                decision.data.decision.dispatchInput
                  ? JSON.stringify(decision.data.decision.dispatchInput)
                  : "—"
              }
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
          </div>
        )}
      </section>

      <p className="text-[12px] leading-[18px] text-ql-fg-tertiary">
        请求 {request.id} · 开始于 {formatDateTimeFull(request.startedAt)}
      </p>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-[12px] text-ql-fg-tertiary">{label}</span>
      <span className="[font-variant-numeric:tabular-nums] text-ql-fg">{value}</span>
    </div>
  );
}
