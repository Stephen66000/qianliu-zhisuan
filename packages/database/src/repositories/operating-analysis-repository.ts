import { loadAnalysisPurchases } from "./operating-analysis-purchases.js";
import { sql, type Kysely } from "kysely";
import type { Database } from "../kysely.js";
import {
  loadApiCostEstimation,
  type ApiCostEstimation,
} from "./api-cost-estimation.js";
import { ProviderFinanceRepository } from "./provider-finance-repository.js";
import { operatingBillMonthRange } from "./operating-bill-month.js";
import {
  addAnalysis,
  AnalysisDecimal,
  analysisMonthUsage,
  analysisRatio,
  loadAnalysisUsage,
  recordedAnalysisUsage,
} from "./operating-analysis-usage.js";

export async function loadOperatingAnalysis(
  db: Kysely<Database>,
  enterpriseId: string,
  selectedMonth: string,
  now = new Date(),
) {
  const selected = operatingBillMonthRange(selectedMonth);
  const year = selectedMonth.slice(0, 4),
    monthNumber = Number(selectedMonth.slice(5));
  const months = Array.from(
    { length: 12 },
    (_, i) => `${year}-${String(i + 1).padStart(2, "0")}`,
  );
  return db
    .transaction()
    .setIsolationLevel("repeatable read")
    .execute(async (trx) => {
      await sql`SET TRANSACTION READ ONLY`.execute(trx);
      const finance = new ProviderFinanceRepository(trx);
      const [facts, cashRows, views, officialApiBalances] = await Promise.all([
        loadAnalysisUsage(trx, enterpriseId, now),
        loadAnalysisPurchases(trx, enterpriseId, selectedMonth, now),
        Promise.all(
          months.map(async (month) => {
            const { start, end } = operatingBillMonthRange(month);
            if (start > now || month > selectedMonth) return [];
            return finance.loadResourceFinanceViews(
              trx,
              enterpriseId,
              month,
              new Date(Math.min(now.getTime(), end.getTime() - 1)),
            );
          }),
        ),
        sql<{
          provider_code: string; provider_name: string; provider_resource_id: string;
          resource_name: string; currency: string; current_balance: string;
          collected_at: Date; balance_updated_at: Date | null;
        }>`
          SELECT DISTINCT ON (snapshot.provider_resource_id)
                 provider.code AS provider_code, provider.name AS provider_name,
                 resource.id AS provider_resource_id, resource.name AS resource_name,
                 snapshot.currency, snapshot.current_balance::text AS current_balance,
                 snapshot.collected_at, snapshot.balance_updated_at
            FROM provider_resource_operating_snapshot snapshot
            JOIN provider_resource resource
              ON resource.enterprise_id=snapshot.enterprise_id
             AND resource.id=snapshot.provider_resource_id
            JOIN provider
              ON provider.enterprise_id=resource.enterprise_id
             AND provider.id=resource.provider_id
           WHERE snapshot.enterprise_id=${enterpriseId}::uuid
             AND resource.mode='API' AND resource.status<>'DELETED'
             AND snapshot.source='PROVIDER_SYNC'
             AND snapshot.balance_source='PROVIDER_API'
             AND snapshot.current_balance IS NOT NULL
             AND snapshot.currency IS NOT NULL
             AND snapshot.collected_at<=${now}
           ORDER BY snapshot.provider_resource_id, snapshot.collected_at DESC,
                    snapshot.version DESC`.execute(trx),
      ]);
      const payments = cashRows.filter((row) => row.month === selectedMonth).map((row) => ({
        id: row.id, providerResourceId: row.resource_id, providerName: row.provider_name,
        resourceName: row.resource_name, eventType: row.event_type, cashPaidCny: row.cash,
        occurredAt: row.occurred_at.toISOString(), externalReference: row.external_reference,
        description: row.description, source: row.source,
      }));
      const currentMonth = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Shanghai",
        year: "numeric",
        month: "2-digit",
      })
        .format(now)
        .slice(0, 7);
      const usageMonths = months.map((month) =>
        analysisMonthUsage(
          month,
          operatingBillMonthRange(month).end,
          now,
          facts,
        ),
      );
      const codes = new Set([
        ...facts.usage
          .filter((row) => row.mode === "CODING_PLAN")
          .map((row) => row.provider_code),
        ...views
          .flat()
          .filter((row) => row.mode === "CODING_PLAN")
          .map((row) => row.providerCode),
      ]);
      const plans = [...codes].sort().map((code) => {
        const usage = facts.usage.filter(
          (row) => row.provider_code === code && row.mode === "CODING_PLAN",
        );
        const history = new Map([...new Set(usage.map((row) => row.month))].map((month) =>
          [month, recordedAnalysisUsage(usage.filter((row) => row.month === month))],
        ));
        const peakTokens = [...history.values()].map((row) => row.totalTokens).reduce<string>(
          (peak, value) =>
            value !== null && new AnalysisDecimal(value).gt(peak)
              ? value
              : peak,
          "0",
        );
        return {
          providerCode: code,
          providerName:
            usage[0]?.provider_name ??
            (code === "kimi" ? "Kimi" : code === "zhipu" ? "智谱" : code),
          peakTokens,
          historyIncomplete: [...history.values()].some((row) => row.usageIncomplete),
          months: months.map((month) => {
            const rows = usage.filter((row) => row.month === month);
            const totalTokens =
              month > currentMonth
                ? null
                : history.has(month)
                  ? history.get(month)!.totalTokens
                  : "0";
            return {
              month,
              totalTokens,
              usageIncomplete: history.get(month)?.usageIncomplete ?? false,
              inputTokens:
                totalTokens === null
                  ? null
                  : addAnalysis(rows.map((row) => row.input)).toFixed(0),
              outputTokens:
                totalTokens === null
                  ? null
                  : addAnalysis(rows.map((row) => row.output)).toFixed(0),
              utilization: analysisRatio(totalTokens, peakTokens),
            };
          }),
        };
      });
      const purchases = [
        ...new Set(
          [...cashRows.map((row) => `${row.provider_code}:${row.mode}`), ...views.flat().map((row) => `${row.providerCode}:${row.mode}`)],
        ),
      ]
        .sort()
        .map((key) => {
          const rows = cashRows.filter(
            (row) => `${row.provider_code}:${row.mode}` === key,
          );
          const monthlyCash = months.map((month) =>
            month > currentMonth || month > selectedMonth
              ? null
              : rows.some((row) => row.month === month && row.cash === null) ? null : addAnalysis(rows.filter((row) => row.month === month).map((row) => row.cash!)).toFixed(2),
          );
          return {
            providerCode: key.split(":")[0]!,
            providerName: rows[0]?.provider_name ?? ({ kimi: "Kimi", zhipu: "智谱", deepseek: "DeepSeek" }[key.split(":")[0]!] ?? key.split(":")[0]!),
            mode: key.split(":")[1] as "API" | "CODING_PLAN",
            monthlyCash,
            yearCash: monthlyCash.some((value, index) => months[index]! <= currentMonth && months[index]! <= selectedMonth && value === null)
              ? null : addAnalysis(monthlyCash.filter((x): x is string => x !== null)).toFixed(2),
          };
        });
      const keys = [
        ...new Set(
          views
            .flat()
            .flatMap((view) =>
              view.mode === "API"
                ? view.accounts.map(
                    (account) => `${view.providerCode}:${account.currency}`,
                  )
                : [],
            ),
        ),
      ].sort();
      // S3c（追加合同 §1 / ACE-03/04/06/07）：月度 apiSpend/apiSpendComplete 的数据源从
      // 资金账户 monthlyApiCost（loadResourceFinanceViews）改为统一入口 loadApiCostEstimation：
      // 按企业＋该月 operatingBillMonthRange 期间的 settled_at 半开窗口聚合 API 模式账本行，
      // 不依赖期初/充值/余额/资金初始化（ACE-03）。资源范围收敛到该厂商当月 views 内的 API
      // 资源集合（operatingBillResourceScope 保证当月有结算行的资源必在 views 中），使各
      // (providerCode, currency) 行金额互斥可加、各行合计与同厂商估算一致、全部行合计与
      // 全企业估算一致（ACE-06 同源）。12 个月×逐厂商聚合与既有每月 loadResourceFinanceViews
      // 的调用量级相当（追加合同 §1.3）；api-cost-estimation.ts 为 S1 产物，语义未改。
      const providerCodes = [...new Set(keys.map((key) => key.split(":")[0]!))];
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
      const firstUsageMonth = facts.usage.map((row) => row.month).sort()[0] ?? selectedMonth;
      const ytd = usageMonths.slice(0, monthNumber).filter((row) => row.month >= firstUsageMonth),
        prior = ytd.slice(0, -1);
      const average = (rows: typeof ytd) =>
        rows.length && rows.every((row) => row.totalTokens !== null)
          ? addAnalysis(rows.map((row) => row.totalTokens!)).div(rows.length)
          : null;
      const currentAverage = average(ytd),
        previousAverage = average(prior);
      const change = (value: string | null, base: string | null) => {
        const ratio = analysisRatio(value, base);
        return ratio === null
          ? null
          : new AnalysisDecimal(ratio).minus(100).toFixed(2);
      };
      const monthlyCash = months.map((month, i) =>
        month > currentMonth || month > selectedMonth
          ? null
          : purchases.some((row) => row.monthlyCash[i] === null) ? null
            : addAnalysis(purchases.map((row) => row.monthlyCash[i] ?? "0")).toFixed(2),
      );
      const yearCash = monthlyCash.some((value, index) => months[index]! <= currentMonth && months[index]! <= selectedMonth && value === null)
        ? null : addAnalysis(monthlyCash.filter((v): v is string => v !== null)).toFixed(2);
      const maxCash = monthlyCash.reduce<string>(
        (maximum, value) =>
          value !== null && new AnalysisDecimal(value).gt(maximum)
            ? value
            : maximum,
        "0",
      );
      const cashSummary = {
        monthlyCash,
        yearCash,
        averageCash:
          selectedMonth > currentMonth || yearCash === null
            ? null
            : new AnalysisDecimal(yearCash).div(monthNumber).toFixed(2),
        highestMonths: new AnalysisDecimal(maxCash).gt(0)
          ? months.filter(
              (_, i) =>
                monthlyCash[i] === new AnalysisDecimal(maxCash).toFixed(2),
            )
          : [],
      };
      const current = usageMonths[monthNumber - 1]!;
      const previous = usageMonths[monthNumber - 2];
      const utilization = ["kimi", "zhipu"].map((code) =>
        plans.find((plan) => plan.providerCode === code)?.months[monthNumber - 1]?.utilization ?? null,
      );
      return {
        month: selectedMonth,
        currentMonth,
        generatedAt: now.toISOString(),
        months: usageMonths,
        plans,
        purchases,
        apiAccounts: apiReviews,
        officialApiBalances: officialApiBalances.rows.map((row) => ({
          providerCode: row.provider_code,
          providerName: row.provider_name,
          providerResourceId: row.provider_resource_id,
          resourceName: row.resource_name,
          currency: row.currency,
          balance: row.current_balance,
          asOf: (row.balance_updated_at ?? row.collected_at).toISOString(),
          syncedAt: row.collected_at.toISOString(),
        })),
        cashSummary,
        payments,
        summary: {
          companyTokens: current.totalTokens,
          ytdAverageTokens: currentAverage?.toFixed(2) ?? null,
          averageMonthCount: ytd.length,
          ytdAverageChange: change(
            currentAverage?.toString() ?? null,
            previousAverage?.toString() ?? null,
          ),
          perCapitaTokens: current.perCapitaTokens,
          perCapitaChange:
            current.totalTokens !== null &&
            current.employeeCount &&
            previous?.totalTokens !== null &&
            previous?.totalTokens &&
            previous.employeeCount
              ? change(
                  new AnalysisDecimal(current.totalTokens)
                    .div(current.employeeCount)
                    .toString(),
                  new AnalysisDecimal(previous.totalTokens)
                    .div(previous.employeeCount)
                    .toString(),
                )
              : null,
          planUtilization: utilization.every((value): value is string => value !== null)
            ? addAnalysis(utilization).div(2).toFixed(2)
            : null,
        },
        periodStart: selected.start.toISOString(),
      };
    });
}
