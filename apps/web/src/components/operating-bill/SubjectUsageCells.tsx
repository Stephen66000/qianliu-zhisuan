import { Link } from "react-router-dom";
import { accountApiMoney, legacyAccountQuota } from "./AccountShared";
import { Fragment } from "react";

import type { OperatingBillEmployeeRow } from "../../api/operating-bill-accounts";
import {
  AccountCell,
  accountCount,
  accountMoney,
  accountTime,
} from "./AccountShared";


export interface DynamicProviderCol {
  code: string;
  name: string;
}

export const DEFAULT_PROVIDER_COLS: DynamicProviderCol[] = [
  { code: "deepseek", name: "DeepSeek" },
  { code: "zhipu", name: "智谱" },
  { code: "kimi", name: "Kimi" },
];

export function extractProviderColumns(
  rows: Array<{ providers: Array<{ providerCode: string; providerName: string }> }>,
): DynamicProviderCol[] {
  const map = new Map<string, string>();
  for (const { code, name } of DEFAULT_PROVIDER_COLS) {
    map.set(code, name);
  }
  for (const row of rows) {
    for (const p of row.providers) {
      if (!map.has(p.providerCode)) {
        map.set(p.providerCode, p.providerName || p.providerCode);
      }
    }
  }
  return Array.from(map.entries()).map(([code, name]) => ({ code, name }));
}

export function getSubjectUsageHeaders(
  providers: DynamicProviderCol[] = DEFAULT_PROVIDER_COLS,
  quotaScope?: "EMPLOYEE",
): string[] {
  const providerHeaders = providers.flatMap((p) => [
    `${p.name} Token`,
    // WP4-S4（ACE-01）：API 厂商列金额与合计同为估算口径（live 行 effectiveReportedApiCostSql）。
    p.code === "deepseek"
      ? `${p.name} API 费用估算`
      : p.code === "zhipu"
        ? "智谱订阅金额"
        : `${p.name} 订阅金额`,
  ]);
  return [
    ...(quotaScope === "EMPLOYEE" ? ["本月token使用量", "厂商额度"] : ["本月分配额度", "本月token使用量", "token使用率", "本月剩余额度"]),
    "输入 Token",
    "输出 Token",
    "缓存命中 Token",
    ...providerHeaders,
    "API 费用估算合计",
    "活跃天数",
    "请求次数",
    "最后一次使用（北京时间）",
  ];
}

export const subjectUsageHeaders = getSubjectUsageHeaders();

export function SubjectUsageCells({
  row,
  providers = DEFAULT_PROVIDER_COLS,
  quotaScope,
}: {
  row: OperatingBillEmployeeRow;
  providers?: DynamicProviderCol[];
  quotaScope?: "EMPLOYEE";
}) {
  const { totals } = row;
  const quota = quotaScope === "EMPLOYEE" ? null : legacyAccountQuota(row.allocatedQuota ?? totals.allocatedQuota, totals.totalTokens);

  return (
    <>
      {quota ? <AccountCell numeric>{quota.allocated}</AccountCell> : null}
      <AccountCell numeric>{accountCount(totals.totalTokens, totals.usageQuality)}</AccountCell>
      {quota ? <><AccountCell numeric>{quota.usageRate}</AccountCell><AccountCell numeric>{quota.remaining}</AccountCell></> :
        <AccountCell><Link className="text-ql-action" to="/principals" aria-label={`${row.subjectName}按厂商池查看额度`}>按厂商池查看</Link></AccountCell>}
      {[
        totals.inputTokens,
        totals.outputTokens,
        totals.cacheTokens,
      ].map((value, index) => (
        <AccountCell key={index} numeric>
          {accountCount(value, totals.usageQuality)}
        </AccountCell>
      ))}
      {providers.map(({ code }) => {
        const provider = row.providers.find(
          (item) => item.providerCode === code,
        );
        // A present provider without the new breakdown is unknown, not unused.
        const usage = provider?.totals;
        const amount =
          code === "deepseek" ? usage?.apiCost : (usage?.packageAllocatedCost ?? usage?.apiCost);
        return (
          <Fragment key={code}>
            <AccountCell numeric>
              {provider
                ? accountCount(
                    usage?.totalTokens ?? null,
                    usage?.usageQuality ?? "UNKNOWN",
                  )
                : "0"}
            </AccountCell>
            <AccountCell numeric>
              {code === "deepseek" && usage
                ? accountApiMoney(usage)
                : accountMoney(provider ? (amount ?? null) : "0")}
            </AccountCell>
          </Fragment>
        );
      })}
      <AccountCell numeric>{accountApiMoney(totals)}</AccountCell>
      <AccountCell numeric>{totals.activeDays ?? "—"}</AccountCell>
      <AccountCell numeric>{totals.requestCount}</AccountCell>
      <AccountCell numeric>{accountTime(totals.lastUsedAt)}</AccountCell>
    </>
  );
}
