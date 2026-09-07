import { accountApiMoney } from "./AccountShared";
import { Fragment } from "react";

import type { OperatingBillEmployeeRow } from "../../api/operating-bill-accounts";
import {
  AccountCell,
  accountCount,
  accountMoney,
  accountTime,
} from "./AccountShared";

export const subjectUsageHeaders = [
  "本月总 Token",
  "输入 Token",
  "输出 Token",
  "缓存命中 Token",
  "DeepSeek Token",
  "DeepSeek API 消费",
  "智谱 Token",
  "智谱订阅金额",
  "Kimi Token",
  "Kimi 订阅金额",
  "API 消费合计",
  "活跃天数",
  "请求次数",
  "最后一次使用（北京时间）",
];

export function SubjectUsageCells({ row }: { row: OperatingBillEmployeeRow }) {
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
      {["deepseek", "zhipu", "kimi"].map((code) => {
        const provider = row.providers.find(
          (item) => item.providerCode === code,
        );
        // A present provider without the new breakdown is unknown, not unused.
        const usage = provider?.totals;
        const amount =
          code === "deepseek" ? usage?.apiCost : usage?.packageAllocatedCost;
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
              {code === "deepseek" && usage ? accountApiMoney(usage) : accountMoney(provider ? (amount ?? null) : "0")}
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
