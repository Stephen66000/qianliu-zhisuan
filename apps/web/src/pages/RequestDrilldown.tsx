import { Button } from "../components/ui/Button";
/**
 * W20 路由过程下钻 —— 候选 / Attempt / 调度决策（PRD §10.3 可展开"路由过程"）。
 *
 * 字体三级收敛 + 颜色纪律；内部快照默认摘要展示，原始调度输入按需展开。
 *
 * 2026-11 v1.5 质量预检整改（GATE-01 第 2/3 批）：结算汇总 / 上游尝试 / 计价决策
 * 三个展示区块及共享 Field、纯函数 helper 拆至 RequestDrilldownSections.tsx，
 * 本组件保留取数编排与调度决策区块，渲染输出不变。
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
import { formatDateTimeFull, formatMoney } from "../lib/format";
import { Field, PricingDecisions, SettlementSummary, UpstreamAttempts } from "./RequestDrilldownSections";

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
      {request.status === "FAILED" || settlement?.status === "FAILED" ? (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-ql-danger/20 bg-ql-danger-soft px-3 py-2 text-[13px] text-ql-danger">
          <span>本次请求未成功完成。实际消耗已如实入账；技术诊断、错误堆栈与重试轨迹请前往异常中心查看。</span>
          <a
            className="font-medium text-ql-action hover:underline"
            href={`/runtime-assurance?tab=exceptions&search=${encodeURIComponent(request.id)}`}
          >
            前往异常中心排查故障 →
          </a>
        </div>
      ) : null}

      <SettlementSummary settlement={settlement} errorCode={request.errorCode} />

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
                <tr className="border-b border-ql-border text-[13px] leading-[18px] text-ql-fg-tertiary">
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
                    <td className="py-2 pr-4 font-mono text-[13px] text-ql-fg-tertiary">
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

      <UpstreamAttempts attempts={attempts} />

      {/* 计价决策与调度决策分区；这里只展示请求时点冻结的账本快照。 */}
      <PricingDecisions attempts={attempts} dispatch={dispatch} />

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
                <summary className="cursor-pointer px-3 py-2 text-[13px] font-medium text-ql-fg-secondary">
                  技术详情（调度输入快照）
                </summary>
                <div className="min-w-0 border-t border-ql-border-zone p-3">
                  <div className="mb-2 flex justify-end">
                    <Button variant="ghost" size="sm"
                      onClick={() => void navigator.clipboard?.writeText(technicalJson)}
                      type="button"
                    >
                      复制技术详情
                    </Button>
                  </div>
                  <pre className="max-w-full whitespace-pre-wrap break-all font-mono text-[13px] leading-5 text-ql-fg-secondary">
                    {technicalJson}
                  </pre>
                </div>
              </details>
            ) : null}
          </div>
        )}
      </section>

      <p className="text-[13px] leading-[18px] text-ql-fg-tertiary">
        请求 {request.id} · 开始于 {formatDateTimeFull(request.startedAt)}
      </p>
    </div>
  );
}
