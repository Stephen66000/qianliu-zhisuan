import type { Kysely } from "kysely";
import type { Database } from "../kysely.js";
import {
  loadApiCostEstimation,
  type ApiCostEstimation,
} from "./api-cost-estimation.js";
import { operatingBillMonthRange } from "./operating-bill-month.js";
import { addAnalysis } from "./operating-analysis-usage.js";
import type { loadAnalysisUsage } from "./operating-analysis-usage.js";
import type { AnalysisPurchaseFact } from "./operating-analysis-purchases.js";
import type { ResourceFinanceView } from "./provider-finance-types.js";

type AnalysisUsageFacts = Awaited<ReturnType<typeof loadAnalysisUsage>>;

/**
 * loadOperatingAnalysis 的 API 账户估算与投影段（原样搬运自 operating-analysis-repository.ts，
 * 语义零变化）：同一次 await Promise.all 聚合 12 个月×逐厂商估算，apiAccounts/apiReviews
 * 为纯同步投影，金额口径（多币种不合并、KNOWN_PARTIAL 缺口、toFixed(2) 展示精度）逐字保留。
 */
export async function loadAnalysisEstimationByMonthProvider(
  trx: Kysely<Database>,
  enterpriseId: string,
  months: string[],
  selectedMonth: string,
  now: Date,
  providerCodes: string[],
  views: ResourceFinanceView[][],
): Promise<Map<string, ApiCostEstimation>> {
      // S3c（追加合同 §1 / ACE-03/04/06/07）：月度 apiSpend/apiSpendComplete 的数据源从
      // 资金账户 monthlyApiCost（loadResourceFinanceViews）改为统一入口 loadApiCostEstimation：
      // 按企业＋该月 operatingBillMonthRange 期间的 settled_at 半开窗口聚合 API 模式账本行，
      // 不依赖期初/充值/余额/资金初始化（ACE-03）。资源范围收敛到该厂商当月 views 内的 API
      // 资源集合（operatingBillResourceScope 保证当月有结算行的资源必在 views 中），使各
      // (providerCode, currency) 行金额互斥可加、各行合计与同厂商估算一致、全部行合计与
      // 全企业估算一致（ACE-06 同源）。12 个月×逐厂商聚合与既有每月 loadResourceFinanceViews
      // 的调用量级相当（追加合同 §1.3）；api-cost-estimation.ts 为 S1 产物，语义未改。
  const estimationByMonthProvider = new Map<string, ApiCostEstimation>();
  await Promise.all(
    months.flatMap((month, i) => {
      const { start, end } = operatingBillMonthRange(month);
      // 与 views 相同的加载门槛：未开始的月份/超出所选月份的月份不产出估算。
      if (start > now || month > selectedMonth) return [];
      return providerCodes.map(async (providerCode) => {
        const resourceIds = views[i]!
          .filter(
            (view) =>
              view.mode === "API" && view.providerCode === providerCode,
          )
          .map((view) => view.resourceId);
        estimationByMonthProvider.set(
          `${month}|${providerCode}`,
          await loadApiCostEstimation(trx, enterpriseId, {
            start,
            end,
            resourceIds,
          }),
        );
      });
    }),
  );
  return estimationByMonthProvider;
}

export function buildAnalysisApiAccounts(params: {
  keys: string[];
  months: string[];
  currentMonth: string;
  facts: AnalysisUsageFacts;
  cashRows: AnalysisPurchaseFact[];
  views: ResourceFinanceView[][];
  estimationByMonthProvider: Map<string, ApiCostEstimation>;
}) {
  const { keys, months, currentMonth, facts, cashRows, views, estimationByMonthProvider } = params;
  const apiAccounts = keys.map((key) => {
    const [providerCode, currency] = key.split(":") as [string, string];
    return {
      providerCode,
      providerName:
        facts.usage.find((row) => row.provider_code === providerCode)
          ?.provider_name ??
        cashRows.find((row) => row.provider_code === providerCode)
          ?.provider_name ??
        providerCode,
      currency,
      months: months.map((month, i) => {
        const resources = views[i]!.filter(
          (view) =>
            view.mode === "API" && view.providerCode === providerCode,
        );
        const accounts = resources.flatMap((view) =>
          view.accounts.filter((account) => account.currency === currency),
        );
        const valid = month <= currentMonth && accounts.length > 0;
        const paid = cashRows.filter((row) => row.month === month && row.currency === currency
          && resources.some((resource) => resource.resourceId === row.resource_id));
        // S3c（追加合同 §1）：apiSpend/apiSpendComplete 改由同源估算派生——
        //   多币种 → null＋false（ACE-07 不混加）；单币种 → 该币种估算金额字面值
        //   （沿用本文件既有 toFixed(2) 展示精度）；期间无 API 行（含仅明确零/合法处置
        //   排除）→ 精确 0＋完整；有缺口行（KNOWN_PARTIAL）→ 已知金额照出（有则）、
        //   complete=false，缺口且无已知金额 → null（ACE-04 不把缺失冒充零、已知部分
        //   保留）；估算未加载（未来/超出所选月份）→ null＋false（与既有 valid=false
        //   语义一致）。
        // 资金域轨迹字段（opening/recharge/paidCny/ending）原样保留（WP2/WP4 处置）。
        const estimation =
          estimationByMonthProvider.get(`${month}|${providerCode}`) ?? null;
        const currencyAmounts = estimation === null
          ? []
          : estimation.amounts.filter((entry) => entry.currency === currency);
        const mixedCurrency =
          estimation !== null && estimation.amounts.length > 1;
        const apiSpend: string | null =
          estimation === null || mixedCurrency
            ? null
            : currencyAmounts.length === 1
              ? addAnalysis([currencyAmounts[0]!.amount]).toFixed(2)
              : estimation.completeness !== "KNOWN_PARTIAL"
                ? addAnalysis([]).toFixed(2)
                : null;
        const apiSpendComplete =
          estimation !== null && !mixedCurrency &&
          estimation.completeness !== "KNOWN_PARTIAL";
        return {
          month,
          openingBalance:
            valid &&
            accounts.every(
              (a) =>
                a.monthOpeningState === "NORMAL" &&
                a.monthOpeningBalance !== null,
            )
              ? addAnalysis(
                  accounts.map((a) => a.monthOpeningBalance!),
                ).toFixed(2)
              : null,
          recharge: valid
            ? addAnalysis(accounts.map((a) => a.monthlyRecharge)).toFixed(2)
            : null,
          paidCny: month <= currentMonth
            ? paid.some((row) => row.cash === null) ? null : addAnalysis(paid.map((row) => row.cash!)).toFixed(2)
            : null,
          apiSpend,
          apiSpendComplete,
          endingBalance:
            valid &&
            accounts.every(
              (a) => a.balanceState === "NORMAL" && a.balance !== null,
            )
              ? addAnalysis(accounts.map((a) => a.balance!)).toFixed(2)
              : null,
        };
      }),
    };
  });
  return apiAccounts;
}

export function buildAnalysisApiReviews(
  apiAccounts: ReturnType<typeof buildAnalysisApiAccounts>,
  monthNumber: number,
) {
  const apiReviews = apiAccounts.map((account) => {
    const rows = account.months.slice(0, monthNumber);
    const total = (field: "recharge" | "paidCny" | "apiSpend") =>
      rows.every((row) => row[field] !== null)
        ? addAnalysis(rows.map((row) => row[field]!)).toFixed(2)
        : null;
    return {
      ...account,
      totals: {
        openingBalance: rows[0]?.openingBalance ?? null,
        recharge: total("recharge"),
        paidCny: total("paidCny"),
        apiSpend: rows.some((row) => row.apiSpend !== null) ? addAnalysis(rows.map((row) => row.apiSpend ?? "0")).toFixed(2) : null,
        apiSpendComplete: rows.every((row) => row.apiSpendComplete),
        endingBalance: rows.at(-1)?.endingBalance ?? null,
      },
    };
  });
  return apiReviews;
}
