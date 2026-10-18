/**
 * 项目账归集详情页（候选 C3 WP05；合同 11 §5）。
 * 成员贡献视角的项目归集明细 + 未分配汇总 + 计算状态；固定 run 分页。
 */
import { useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";

import {
  useAllocationLines, useAllocationStatus, useCreateAllocationRun,
  useEnableAllocation, useUnallocated, type UnallocatedView, type AllocationStatusView,
} from "../api/project-allocation";
import { AccountPagination } from "../components/operating-bill/AccountShared";
import { BillCard, SectionHeading } from "../components/operating-bill/BillShared";
import { operatingBillMonth, OperatingBillShell } from "../components/operating-bill/OperatingBillShell";
import { EmptyState } from "../components/states/EmptyState";
import { ErrorState } from "../components/states/ErrorState";
import { LoadingState } from "../components/states/LoadingState";
import { Button } from "../components/ui/Button";
import { useRedirectOnUnauthorized } from "../components/useRedirectOnUnauthorized";
import { usageQualityLabel } from "../lib/usage-quality";
import { ListTree } from "lucide-react";
import { Cell, Num, Table } from "./OperatingBillShared";

/** 归集明细固定 run 分页，每页 25 行（与服务端 limit 一致）。 */
const PAGE_SIZE = 25;
const METRIC_CLASS = "mt-1 text-[20px] font-semibold leading-7 text-ql-fg";

const REASON_LABELS: Record<string, string> = {
  HISTORICAL_UNKNOWN: "历史关系未知",
  NO_MEMBERSHIP: "无参与关系",
  NO_EFFECTIVE_RULE: "无生效规则",
  WEIGHT_REMAINDER: "权重余量",
  RULE_PENDING_REPAIR: "规则待修复",
};

const SOURCE_LABELS: Record<string, string> = {
  PROJECT_DIRECT: "项目直接调用",
  MANUAL_ASSIGNMENT: "人工指定",
  MEMBERSHIP_RULE: "成员规则分摊",
  UNALLOCATED: "未分配",
};

/** 最近一个未完成/失败批次的展示（QUEUED/RUNNING/FAILED；current 恒为成功结果）。 */
function LatestRunNote({ run }: { run: AllocationStatusView["latestRun"] }) {
  if (run === null || run === undefined || run.status === "SUCCEEDED") return null;
  const label = run.status === "QUEUED" ? "已登记批次，等待执行"
    : run.status === "RUNNING" ? "批次计算中"
      : `批次失败：${run.lastError ?? "未知原因"}`;
  return <p className="text-[13px] text-ql-fg-secondary">{label}</p>;
}

/**
 * 企业级未分配明细（合同 §3.3：汇总及明细）。项目明细只含本项目份额，
 * 因此未分配的来源行在这里单独呈现，避免与项目口径混算。
 */
function UnallocatedDetailList({ view }: { view: UnallocatedView | undefined }) {
  const lines = view?.detail?.lines ?? [];
  return (
    <>
      {lines.slice(0, 5).map((line) => (
        <p key={line.ledgerLineId} className="mt-1 text-[13px] text-ql-fg-secondary">
          {REASON_LABELS[line.unallocatedReason ?? ""] ?? line.unallocatedReason ?? "未分配"}
          {" · "}
          {line.employeeName ?? "未知员工"}
          {" · "}
          {line.shareInputTokens} Token
        </p>
      ))}
      {(view?.detail?.total ?? 0) > 5 && (
        <p className="mt-1 text-[13px] text-ql-fg-tertiary">共 {view?.detail?.total ?? 0} 条未分配源行</p>
      )}
    </>
  );
}

export function OperatingBillProjectAllocationPage() {
  const { principalId } = useParams<{ principalId: string }>();
  const [params] = useSearchParams();
  const month = operatingBillMonth(params.get("month"));
  const [offset, setOffset] = useState(0);
  const status = useAllocationStatus(month);
  const lines = useAllocationLines(month, principalId ?? "", offset);
  const unallocated = useUnallocated(month);
  const enable = useEnableAllocation(month);
  const createRun = useCreateAllocationRun(month);
  useRedirectOnUnauthorized(status.error);

  const allocationRows = lines.data && lines.data.runId !== null ? lines.data : null;

  return (
    <OperatingBillShell active="projects" month={month}>
      <div className="space-y-4">
        <BillCard>
          <SectionHeading
            description="依据管理规则归集，不代表实际工作内容；涉及请求数按目标去重，跨项目不可相加。"
            title="项目归集明细"
          />
        </BillCard>

        {status.data?.enabled === false && (
          <BillCard className="p-4">
            <div className="flex flex-wrap items-center gap-3">
              <p className="text-sm text-ql-fg-secondary">该账期未启用项目归集。</p>
              <Button
                disabled={enable.isPending}
                variant="primary"
                onClick={() => enable.mutate(
                  { startMonth: month, reason: "项目账页启用归集" },
                  { onSuccess: () => undefined, onError: (error) => void error },
                )}
              >
                启用项目归集
              </Button>
            </div>
          </BillCard>
        )}

        {status.data?.enabled && (
          <div className="grid gap-3 sm:grid-cols-3">
            <BillCard className="p-4">
              <p className="text-[13px] text-ql-fg-secondary">计算状态</p>
              <p className={METRIC_CLASS}>
                {status.data.currentRun === null
                  ? "待计算"
                  : status.data.currentRun.status === "SUCCEEDED"
                    ? status.data.currentRun.stale ? "待更新" : "可用"
                    : status.data.currentRun.status}
              </p>
              {status.data.currentRun?.computedAt && (
                <p className="text-[13px] text-ql-fg-secondary">
                  计算于 {new Date(status.data.currentRun.computedAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}
                </p>
              )}
              {status.data.lastError && <p className="text-[13px] text-ql-danger">{status.data.lastError}</p>}
              <LatestRunNote run={status.data?.latestRun} />
            </BillCard>
            <BillCard className="p-4">
              <p className="text-[13px] text-ql-fg-secondary">未分配 Token</p>
              <p className={`${METRIC_CLASS} tabular-nums`}>{unallocated.data?.tokens ?? "—"}</p>
              <p className="text-[13px] text-ql-fg-secondary">
                {Object.entries(unallocated.data?.byReason ?? {})
                  .map(([reason, tokens]) => `${REASON_LABELS[reason] ?? reason} ${tokens}`)
                  .join("；") || "无明细"}
              </p>
              {/* 项目明细只含本项目份额；企业级未分配明细在此呈现（合同 §3.3）。 */}
              <UnallocatedDetailList view={unallocated.data} />
            </BillCard>
            <BillCard className="p-4">
              <p className="text-[13px] text-ql-fg-secondary">批次操作</p>
              <Button
                className="mt-2"
                disabled={createRun.isPending}
                onClick={() => createRun.mutate(
                  { reason: "项目账页手工促发" },
                  { onSuccess: () => undefined, onError: (error) => void error },
                )}
              >
                促发重算
              </Button>
              <p className="mt-1 text-[13px] text-ql-fg-secondary">促发不绕过单任务约束；页面读取不创建任务。</p>
            </BillCard>
          </div>
        )}

        <BillCard className="overflow-hidden">
          {lines.isLoading && <LoadingState />}
          {lines.isError && <ErrorState message={(lines.error as Error).message} />}
          {lines.data && lines.data.runId === null && (
            <EmptyState icon={ListTree} title="该账期还没有可用的归集批次" description="启用归集并等待计算完成后展示明细。" />
          )}
          {allocationRows && (
            <Table headers={["请求开始时间", "员工", "来源", "份额 Token", "份额 API 费用", "份额套餐成本", "质量"]}>
              {allocationRows.lines.map((line) => (
                <tr key={`${line.ledgerLineId}-${line.allocationSource}`} className="border-b border-ql-border-zone">
                  <Cell>{new Date(line.requestStartedAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}</Cell>
                  <Cell>{line.employeeName ?? "项目主体"}</Cell>
                  <Cell>
                    {SOURCE_LABELS[line.allocationSource] ?? line.allocationSource}
                    {line.weightBps !== null ? `（${(line.weightBps / 100).toFixed(2)}%）` : ""}
                  </Cell>
                  <Num>{(Number(line.shareInputTokens) + Number(line.shareOutputTokens)).toFixed(4)}</Num>
                  <Num>{line.shareApiCost === null ? "—" : `${line.shareApiCost} ${line.apiCostCurrency ?? ""}`}</Num>
                  <Num>{line.sharePackageCost ?? "—"}</Num>
                  <Cell>{usageQualityLabel(line.usageQuality)}</Cell>
                </tr>
              ))}
              {allocationRows.lines.length === 0 && (
                <tr><td colSpan={7} className="px-4 py-6 text-center text-[13px] text-ql-fg-tertiary">无明细</td></tr>
              )}
            </Table>
          )}
          {allocationRows && allocationRows.total > PAGE_SIZE && (
            <AccountPagination
              limit={PAGE_SIZE}
              offset={offset}
              total={allocationRows.total}
              onOffsetChange={setOffset}
            />
          )}
        </BillCard>
      </div>
    </OperatingBillShell>
  );
}
