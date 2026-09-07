import { sql, type Kysely } from "kysely";
import type { Database } from "../kysely.js";
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

interface CashFact {
  month: string;
  resource_id: string;
  provider_code: string;
  provider_name: string;
  mode: "API" | "CODING_PLAN";
  currency: string;
  cash: string;
}
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
      const [facts, cashResult, views, paymentResult] = await Promise.all([
        loadAnalysisUsage(trx, enterpriseId, now),
        sql<CashFact>`SELECT to_char(event.occurred_at AT TIME ZONE 'Asia/Shanghai','YYYY-MM') AS month,
        resource.id AS resource_id,provider.code AS provider_code,provider.name AS provider_name,resource.mode,event.account_currency AS currency,
        SUM(event.cash_paid_cny)::text AS cash
        FROM provider_finance_event event
        JOIN provider_resource resource ON resource.enterprise_id=event.enterprise_id AND resource.id=event.provider_resource_id
        JOIN provider ON provider.enterprise_id=resource.enterprise_id AND provider.id=resource.provider_id
        WHERE event.enterprise_id=${enterpriseId}::uuid
          AND event.occurred_at>=${new Date(`${year}-01-01T00:00:00+08:00`)}
          AND event.occurred_at<${new Date(`${Number(year) + 1}-01-01T00:00:00+08:00`)} AND event.occurred_at<=${new Date(Math.min(now.getTime(), selected.end.getTime() - 1))}
          AND event.event_type IN ('API_RECHARGE','CODING_PLAN_PURCHASE','CODING_PLAN_RENEWAL','REVERSAL')
          AND event.cash_paid_cny IS NOT NULL AND event.cash_paid_cny<>0
        GROUP BY month,resource.id,provider.code,provider.name,resource.mode,event.account_currency`.execute(
          trx,
        ),
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
          id: string;
          provider_resource_id: string;
          provider_name: string;
          resource_name: string;
          event_type: string;
          cash_paid_cny: string;
          occurred_at: Date;
          external_reference: string | null;
          description: string | null;
        }>`SELECT event.id,event.provider_resource_id,provider.name AS provider_name,resource.name AS resource_name,event.event_type,event.cash_paid_cny::text,event.occurred_at,event.external_reference,event.description
         FROM provider_finance_event event JOIN provider_resource resource ON resource.enterprise_id=event.enterprise_id AND resource.id=event.provider_resource_id
         JOIN provider ON provider.enterprise_id=resource.enterprise_id AND provider.id=resource.provider_id
         WHERE event.enterprise_id=${enterpriseId}::uuid AND event.occurred_at>=${selected.start} AND event.occurred_at<${selected.end} AND event.occurred_at<=${now}
           AND event.event_type IN ('API_RECHARGE','CODING_PLAN_PURCHASE','CODING_PLAN_RENEWAL','REVERSAL') AND event.cash_paid_cny IS NOT NULL AND event.cash_paid_cny<>0
         ORDER BY event.occurred_at DESC,event.created_at DESC,event.id DESC`.execute(
          trx,
        ),
      ]);
      const payments = paymentResult.rows.map((row) => ({
        id: row.id,
        providerResourceId: row.provider_resource_id,
        providerName: row.provider_name,
        resourceName: row.resource_name,
        eventType: row.event_type,
        cashPaidCny: row.cash_paid_cny,
        occurredAt: row.occurred_at.toISOString(),
        externalReference: row.external_reference,
        description: row.description,
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
          cashResult.rows.map((row) => `${row.provider_code}:${row.mode}`),
        ),
      ]
        .sort()
        .map((key) => {
          const rows = cashResult.rows.filter(
            (row) => `${row.provider_code}:${row.mode}` === key,
          );
          const monthlyCash = months.map((month) =>
            month > currentMonth || month > selectedMonth
              ? null
              : addAnalysis(
                  rows
                    .filter((row) => row.month === month)
                    .map((row) => row.cash),
                ).toFixed(2),
          );
          return {
            providerCode: rows[0]!.provider_code,
            providerName: rows[0]!.provider_name,
            mode: rows[0]!.mode,
            monthlyCash,
            yearCash: addAnalysis(
              monthlyCash.filter((x): x is string => x !== null),
            ).toFixed(2),
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
      const apiAccounts = keys.map((key) => {
        const [providerCode, currency] = key.split(":") as [string, string];
        return {
          providerCode,
          providerName:
            facts.usage.find((row) => row.provider_code === providerCode)
              ?.provider_name ??
            cashResult.rows.find((row) => row.provider_code === providerCode)
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
              paidCny:
                month <= currentMonth
                  ? addAnalysis(
                      cashResult.rows
                        .filter(
                          (row) =>
                            row.month === month &&
                            row.currency === currency &&
                            resources.some(
                              (r) => r.resourceId === row.resource_id,
                            ),
                        )
                        .map((row) => row.cash),
                    ).toFixed(2)
                  : null,
              apiSpend:
                valid &&
                accounts.every(
                  (a) =>
                    a.balanceState !== "INCOMPLETE_USAGE_COST" &&
                    a.balanceState !== "LEGACY_ARCHIVED",
                )
                  ? addAnalysis(accounts.map((a) => a.monthlyApiCost)).toFixed(
                      2,
                    )
                  : null,
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
            apiSpend: total("apiSpend"),
            endingBalance: rows.at(-1)?.endingBalance ?? null,
          },
        };
      });
      const ytd = usageMonths.slice(0, monthNumber),
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
          : addAnalysis(
              purchases.map((row) => row.monthlyCash[i] ?? "0"),
            ).toFixed(2),
      );
      const yearCash = addAnalysis(
        monthlyCash.filter((v): v is string => v !== null),
      ).toFixed(2);
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
          selectedMonth > currentMonth
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
        cashSummary,
        payments,
        summary: {
          companyTokens: current.totalTokens,
          ytdAverageTokens: currentAverage?.toFixed(2) ?? null,
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
