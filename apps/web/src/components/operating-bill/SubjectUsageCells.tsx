import { accountApiMoney } from "./AccountShared";
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
): string[] {
  const providerHeaders = providers.flatMap((p) => [
    `${p.name} Token`,
    p.code === "deepseek"
      ? `${p.name} API 消费`
      : p.code === "zhipu"
        ? "智谱订阅金额"
        : `${p.name} 订阅金额`,
  ]);
  return [
    "本月总 Token",
    "输入 Token",
    "输出 Token",
    "缓存命中 Token",
    ...providerHeaders,
    "API 消费合计",
    "活跃天数",
    "请求次数",
    "最后一次使用（北京时间）",
  ];
}

export const subjectUsageHeaders = getSubjectUsageHeaders();

export function SubjectUsageCells({
  row,
  providers = DEFAULT_PROVIDER_COLS,
}: {
  row: OperatingBillEmployeeRow;
  providers?: DynamicProviderCol[];
}) {
  const { totals } = row;
  return (
    <>
      {[
        totals.totalTokens,
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
