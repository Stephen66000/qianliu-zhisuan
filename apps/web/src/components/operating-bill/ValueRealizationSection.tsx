import { useMemo } from "react";
import type { OperatingAnalysis } from "../../api/operating-analysis";
import { BillCard, SectionHeading } from "./BillShared";
import { formatMoney } from "../../lib/format";

const fmt = (v: number | string) =>
  typeof v === "number" ? formatMoney(v.toFixed(2)) : formatMoney(v);

/** 数据缺失时的展示占位：禁止伪造精确数字（空状态纪律）。 */
const NA = "数据不足";

const show = <T,>(value: T | null | undefined, render: (v: T) => string): string =>
  value === null || value === undefined ? NA : render(value);

/**
 * 官方同级 API 市价参考基准（手工维护）：厂商公开刊例价，非系统实时取数。
 * 厂商调价后需人工更新 updatedAt 与对应单价；页面对外展示时须注明来源与日期。
 */
export const OFFICIAL_RATE_REFERENCE = {
  updatedAt: "2026-09-18",
  kimi: 12.0,
  zhipu: 15.0,
} as const;

export interface PlanValueRow {
  price: number;
  tokensM: number;
  unitCost: number;
  officialRate: number;
  officialCost: number;
  savings: number;
  discount: number;
}

export function computePlanValueRow(
  price: number,
  tokensM: number,
  officialRate: number,
): PlanValueRow {
  const unitCost = price / tokensM;
  const officialCost = tokensM * officialRate;
  return {
    price,
    tokensM,
    unitCost,
    officialRate,
    officialCost,
    savings: Math.max(0, officialCost - price),
    discount: (unitCost / officialRate) * 10,
  };
}

export interface PlanValueSummary {
  totalPlanPrice: number;
  totalPlanTokensM: number;
  totalOfficialCost: number;
  blendedOfficialRate: number;
  weightedUnitCost: number;
  weightedDiscount: number;
  totalPlanSavings: number;
}

/** 汇总口径：官方基准单价按 Token 加权（总等效 API 成本 ÷ 总 Token），折扣由汇总金额推导，与明细行完全自洽。 */
export function computePlanValueSummary(
  kimi: PlanValueRow,
  zhipu: PlanValueRow,
): PlanValueSummary {
  const totalPlanPrice = kimi.price + zhipu.price;
  const totalPlanTokensM = kimi.tokensM + zhipu.tokensM;
  const totalOfficialCost = kimi.officialCost + zhipu.officialCost;
  const blendedOfficialRate = totalOfficialCost / totalPlanTokensM;
  const weightedUnitCost = totalPlanPrice / totalPlanTokensM;
  const weightedDiscount = (weightedUnitCost / blendedOfficialRate) * 10;
  return {
    totalPlanPrice,
    totalPlanTokensM,
    totalOfficialCost,
    blendedOfficialRate,
    weightedUnitCost,
    weightedDiscount,
    totalPlanSavings: totalOfficialCost - totalPlanPrice,
  };
}

interface AccountReuse {
  users: number;
  savedAccounts: number;
  savedMoney: number;
}

interface ValueView {
  activeCount: number | null;
  kimi: PlanValueRow | null;
  zhipu: PlanValueRow | null;
  summary: PlanValueSummary | null;
  kimiReuse: AccountReuse | null;
  zhipuReuse: AccountReuse | null;
  totalSavedAccounts: number | null;
  totalSavedMoney: number | null;
  avgMultiplexRatio: number | null;
  card1Sub: string;
  card2Sub: string;
  badge1: string;
  badge2: string;
  referenceNote: string;
}

function positiveNumber(raw: string | null | undefined, divisor = 1): number | null {
  if (raw === null || raw === undefined) return null;
  const value = Number(raw) / divisor;
  return Number.isFinite(value) && value > 0 ? value : null;
}

function buildValueView(analysis: OperatingAnalysis | undefined, month: string): ValueView {
  const current = analysis?.months.find((m) => m.month === month);
  const activeCount = current?.activeEmployees ?? null;
  const monthIndex = analysis?.months.findIndex((m) => m.month === month) ?? -1;

  // 套餐月费取自经营账单当月套餐付款净额（purchases.monthlyCash 与 months 对齐）
  const planCash = (code: string): number | null => {
    if (monthIndex < 0) return null;
    const row = analysis?.purchases.find(
      (p) => p.providerCode === code && p.mode === "CODING_PLAN",
    );
    return positiveNumber(row?.monthlyCash[monthIndex]);
  };
  const planTokensM = (code: string): number | null =>
    positiveNumber(
      analysis?.plans
        .find((p) => p.providerCode === code)
        ?.months.find((m) => m.month === month)?.totalTokens,
      1_000_000,
    );

  const kimiPrice = planCash("kimi");
  const zhipuPrice = planCash("zhipu");
  const kimi =
    kimiPrice !== null && planTokensM("kimi") !== null
      ? computePlanValueRow(kimiPrice, planTokensM("kimi")!, OFFICIAL_RATE_REFERENCE.kimi)
      : null;
  const zhipu =
    zhipuPrice !== null && planTokensM("zhipu") !== null
      ? computePlanValueRow(zhipuPrice, planTokensM("zhipu")!, OFFICIAL_RATE_REFERENCE.zhipu)
      : null;
  const summary = kimi && zhipu ? computePlanValueSummary(kimi, zhipu) : null;

  const kimiReuse: AccountReuse | null =
    activeCount !== null && kimiPrice !== null
      ? {
          users: Math.max(1, activeCount),
          savedAccounts: Math.max(0, Math.max(1, activeCount) - 1),
          savedMoney: Math.max(0, Math.max(1, activeCount) - 1) * kimiPrice,
        }
      : null;
  const zhipuReuse: AccountReuse | null =
    activeCount !== null && zhipuPrice !== null
      ? {
          users: Math.max(1, Math.min(activeCount, 5)),
          savedAccounts: Math.max(0, Math.max(1, Math.min(activeCount, 5)) - 1),
          savedMoney: Math.max(0, Math.max(1, Math.min(activeCount, 5)) - 1) * zhipuPrice,
        }
      : null;

  const totalSavedAccounts =
    kimiReuse && zhipuReuse ? kimiReuse.savedAccounts + zhipuReuse.savedAccounts : null;
  const totalSavedMoney =
    kimiReuse && zhipuReuse ? kimiReuse.savedMoney + zhipuReuse.savedMoney : null;
  const avgMultiplexRatio =
    kimiReuse && zhipuReuse ? (kimiReuse.users + zhipuReuse.users) / 2 : null;

  const card1Sub =
    totalSavedAccounts !== null && kimiReuse && zhipuReuse
      ? `少购 ${totalSavedAccounts} 个账号（Kimi ¥${fmt(kimiReuse.savedMoney)} + 智谱 ¥${fmt(zhipuReuse.savedMoney)}）`
      : NA;
  const card2Sub = show(activeCount, (v) => `各买 1 个账号，平稳保障 ${v} 人高频共享使用`);
  const badge1 =
    totalSavedAccounts !== null && totalSavedMoney !== null
      ? `少购 ${totalSavedAccounts} 个独立账号 · 月度净省 ¥${fmt(totalSavedMoney)}`
      : NA;
  const badge2 = show(
    summary,
    (s) => `实际 Token 摊薄单价低至 ${s.weightedDiscount.toFixed(1)} 折`,
  );

  return {
    activeCount,
    kimi,
    zhipu,
    summary,
    kimiReuse,
    zhipuReuse,
    totalSavedAccounts,
    totalSavedMoney,
    avgMultiplexRatio,
    card1Sub,
    card2Sub,
    badge1,
    badge2,
    referenceNote: `官方市价为参考基准（手工维护，更新于 ${OFFICIAL_RATE_REFERENCE.updatedAt}）；套餐月费取自当月经营账单套餐付款净额，数据缺失时显示「${NA}」。`,
  };
}

interface ValueRealizationSectionProps {
  analysis?: OperatingAnalysis;
  month: string;
}

const discountText = (discount: number) =>
  `${discount.toFixed(1)} 折 (-${(100 - discount * 10).toFixed(1)}%)`;

const tokensText = (tokensM: number) =>
  `${tokensM.toFixed(2)} M (${(tokensM * 100).toFixed(0)}万)`;

export function ValueRealizationSection({ analysis, month }: ValueRealizationSectionProps) {
  const view = useMemo(() => buildValueView(analysis, month), [analysis, month]);

  return (
    <div className="space-y-5" role="region" aria-label="价值体现">
      {/* 顶部四大价值指标卡 */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-xl border border-ql-border bg-ql-surface p-4 shadow-sm">
          <div className="text-xs text-ql-fg-secondary mb-1">当月账号等效少购节约</div>
          <div className="text-2xl font-bold text-ql-success tabular-nums">
            {show(view.totalSavedMoney, (v) => `¥ ${fmt(v)}`)}
          </div>
          <div className="text-[11px] text-ql-fg-tertiary mt-1">{view.card1Sub}</div>
        </div>

        <div className="rounded-xl border border-ql-border bg-ql-surface p-4 shadow-sm">
          <div className="text-xs text-ql-fg-secondary mb-1">账号平均复用倍比</div>
          <div className="text-2xl font-bold text-ql-action tabular-nums">
            {show(view.avgMultiplexRatio, (v) => `${v.toFixed(1)}x`)}
          </div>
          <div className="text-[11px] text-ql-fg-tertiary mt-1">{view.card2Sub}</div>
        </div>

        <div className="rounded-xl border border-ql-border bg-ql-surface p-4 shadow-sm">
          <div className="text-xs text-ql-fg-secondary mb-1">Coding Plan 实际摊薄单价</div>
          <div className="text-2xl font-bold text-ql-accent tabular-nums">
            {view.summary ? (
              <>
                ¥ {view.summary.weightedUnitCost.toFixed(2)}{" "}
                <span className="text-xs font-normal text-ql-fg-secondary">/ 百万 Token</span>
              </>
            ) : (
              NA
            )}
          </div>
          <div className="text-[11px] text-ql-fg-tertiary mt-1">
            较官方同级 API 市价相当于{" "}
            <span className="font-semibold text-ql-success">
              {show(view.summary, (s) => `${s.weightedDiscount.toFixed(1)} 折`)}
            </span>
          </div>
        </div>

        <div className="rounded-xl border border-ql-border bg-ql-surface p-4 shadow-sm">
          <div className="text-xs text-ql-fg-secondary mb-1">Coding Plan 等效采购降本</div>
          <div className="text-2xl font-bold text-ql-success tabular-nums">
            {show(view.summary, (s) => `¥ ${fmt(s.totalPlanSavings)}`)}
          </div>
          <div className="text-[11px] text-ql-fg-tertiary mt-1">
            本月包月产出折合官方 API 市价成本差额
          </div>
        </div>
      </div>

      {/* 价值卡片 1：账号复用核算表 */}
      <BillCard className="overflow-hidden">
        <div className="p-4 border-b border-ql-border-zone flex items-center justify-between">
          <SectionHeading title="1. 账号复用核算表" />
          <span className="text-xs font-semibold text-ql-success bg-ql-success-soft px-2.5 py-1 rounded-md">
            {view.badge1}
          </span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs text-left">
            <thead className="bg-ql-surface-subtle text-ql-fg-secondary border-b border-ql-border-zone font-medium">
              <tr>
                <th className="p-3">产品 / 厂商</th>
                <th className="p-3 text-right">已购账号数</th>
                <th className="p-3 text-right">当月实际使用人数</th>
                <th className="p-3 text-right">复用倍比</th>
                <th className="p-3 text-right">等效少购账号数</th>
                <th className="p-3 text-right">单账号采购月费</th>
                <th className="p-3 text-right font-bold text-ql-fg">等效节约月度资金</th>
                <th className="p-3 text-right">当前承载评估</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ql-border-zone">
              <tr className="hover:bg-ql-surface-subtle">
                <td className="p-3 font-semibold text-ql-fg">Kimi Coding Plan</td>
                <td className="p-3 text-right tabular-nums">1 个</td>
                <td className="p-3 text-right tabular-nums font-semibold text-ql-action">
                  {show(view.kimiReuse, (r) => `${r.users} 人 (全员)`)}
                </td>
                <td className="p-3 text-right tabular-nums font-bold text-ql-success">
                  {show(view.kimiReuse, (r) => `${r.users.toFixed(1)}x`)}
                </td>
                <td className="p-3 text-right tabular-nums text-ql-success">
                  {show(view.kimiReuse, (r) => `${r.savedAccounts} 个`)}
                </td>
                <td className="p-3 text-right tabular-nums">
                  {show(view.kimi, (p) => `¥ ${fmt(p.price)}`)}
                </td>
                <td className="p-3 text-right tabular-nums font-bold text-ql-success">
                  {show(view.kimiReuse, (r) => `¥ ${fmt(r.savedMoney)}`)}
                </td>
                <td className="p-3 text-right text-ql-fg-secondary">支撑良好，可满足 6~8 人使用</td>
              </tr>
              <tr className="hover:bg-ql-surface-subtle">
                <td className="p-3 font-semibold text-ql-fg">智谱 Coding Plan</td>
                <td className="p-3 text-right tabular-nums">1 个</td>
                <td className="p-3 text-right tabular-nums font-semibold text-ql-action">
                  {show(view.zhipuReuse, (r) => `${r.users} 人`)}
                </td>
                <td className="p-3 text-right tabular-nums font-bold text-ql-success">
                  {show(view.zhipuReuse, (r) => `${r.users.toFixed(1)}x`)}
                </td>
                <td className="p-3 text-right tabular-nums text-ql-success">
                  {show(view.zhipuReuse, (r) => `${r.savedAccounts} 个`)}
                </td>
                <td className="p-3 text-right tabular-nums">
                  {show(view.zhipu, (p) => `¥ ${fmt(p.price)}`)}
                </td>
                <td className="p-3 text-right tabular-nums font-bold text-ql-success">
                  {show(view.zhipuReuse, (r) => `¥ ${fmt(r.savedMoney)}`)}
                </td>
                <td className="p-3 text-right text-ql-fg-secondary">支撑良好，可满足 6~8 人使用</td>
              </tr>
              <tr className="hover:bg-ql-surface-subtle">
                <td className="p-3 font-semibold text-ql-fg">DeepSeek (API 集中托管)</td>
                <td className="p-3 text-right tabular-nums">1 个企业 Key</td>
                <td className="p-3 text-right tabular-nums font-semibold text-ql-action">
                  {show(view.activeCount, (v) => `${v} 人 (全员)`)}
                </td>
                <td className="p-3 text-right tabular-nums">—</td>
                <td className="p-3 text-right tabular-nums">—</td>
                <td className="p-3 text-right tabular-nums">按量扣费</td>
                <td className="p-3 text-right tabular-nums text-ql-fg-secondary">—</td>
                <td className="p-3 text-right text-ql-fg-secondary">统一预充值并自动路由，杜绝分散报销</td>
              </tr>
            </tbody>
            <tfoot className="bg-ql-surface-subtle font-semibold border-t border-ql-border">
              <tr>
                <td className="p-3 text-ql-fg">合计节约</td>
                <td className="p-3 text-right tabular-nums">2 个账号</td>
                <td className="p-3 text-right tabular-nums">
                  {show(view.activeCount, (v) => `${v} 人使用`)}
                </td>
                <td className="p-3 text-right tabular-nums font-bold text-ql-success">
                  {show(view.avgMultiplexRatio, (v) => `${v.toFixed(1)}x`)}
                </td>
                <td className="p-3 text-right tabular-nums font-bold text-ql-success">
                  {show(view.totalSavedAccounts, (v) => `${v} 个账号`)}
                </td>
                <td className="p-3 text-right tabular-nums">
                  {show(view.summary, (s) => `¥ ${fmt(s.totalPlanPrice)}`)}
                </td>
                <td className="p-3 text-right tabular-nums font-bold text-ql-success">
                  {show(view.totalSavedMoney, (v) => `¥ ${fmt(v)}`)}
                </td>
                <td className="p-3 text-right text-ql-fg-secondary">—</td>
              </tr>
            </tfoot>
          </table>
        </div>
      </BillCard>

      {/* 价值卡片 2：Coding Plan 额度摊薄单价与超值对比 */}
      <BillCard className="overflow-hidden">
        <div className="p-4 border-b border-ql-border-zone flex items-center justify-between">
          <SectionHeading title="2. Coding Plan 额度摊薄单价与超值对比" />
          <span className="text-xs font-semibold text-ql-action bg-ql-action-soft px-2.5 py-1 rounded-md">
            {view.badge2}
          </span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs text-left">
            <thead className="bg-ql-surface-subtle text-ql-fg-secondary border-b border-ql-border-zone font-medium">
              <tr>
                <th className="p-3">套餐产品</th>
                <th className="p-3 text-right">本月实付月费</th>
                <th className="p-3 text-right">当月实际产出 Token</th>
                <th className="p-3 text-right font-bold text-ql-accent">实际摊薄单价</th>
                <th className="p-3 text-right">官方同级 API 市价</th>
                <th className="p-3 text-right">等效 API 采购成本</th>
                <th className="p-3 text-right font-bold text-ql-success">直接降本金额</th>
                <th className="p-3 text-right font-bold text-ql-success">等效折扣率</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ql-border-zone">
              <tr className="hover:bg-ql-surface-subtle">
                <td className="p-3 font-semibold text-ql-fg">Kimi Coding Plan</td>
                <td className="p-3 text-right tabular-nums">
                  {show(view.kimi, (p) => `¥ ${fmt(p.price)}`)}
                </td>
                <td className="p-3 text-right tabular-nums font-medium">
                  {show(view.kimi, (p) => tokensText(p.tokensM))}
                </td>
                <td className="p-3 text-right tabular-nums font-bold text-ql-accent">
                  {show(view.kimi, (p) => `¥ ${p.unitCost.toFixed(2)} / M`)}
                </td>
                <td className="p-3 text-right tabular-nums text-ql-fg-secondary">
                  ¥ {OFFICIAL_RATE_REFERENCE.kimi.toFixed(2)} / M
                </td>
                <td className="p-3 text-right tabular-nums">
                  {show(view.kimi, (p) => `¥ ${fmt(p.officialCost)}`)}
                </td>
                <td className="p-3 text-right tabular-nums font-bold text-ql-success">
                  {show(view.kimi, (p) => `¥ ${fmt(p.savings)}`)}
                </td>
                <td className="p-3 text-right tabular-nums font-semibold text-ql-success">
                  {show(view.kimi, (p) => discountText(p.discount))}
                </td>
              </tr>
              <tr className="hover:bg-ql-surface-subtle">
                <td className="p-3 font-semibold text-ql-fg">智谱 Coding Plan</td>
                <td className="p-3 text-right tabular-nums">
                  {show(view.zhipu, (p) => `¥ ${fmt(p.price)}`)}
                </td>
                <td className="p-3 text-right tabular-nums font-medium">
                  {show(view.zhipu, (p) => tokensText(p.tokensM))}
                </td>
                <td className="p-3 text-right tabular-nums font-bold text-ql-accent">
                  {show(view.zhipu, (p) => `¥ ${p.unitCost.toFixed(2)} / M`)}
                </td>
                <td className="p-3 text-right tabular-nums text-ql-fg-secondary">
                  ¥ {OFFICIAL_RATE_REFERENCE.zhipu.toFixed(2)} / M
                </td>
                <td className="p-3 text-right tabular-nums">
                  {show(view.zhipu, (p) => `¥ ${fmt(p.officialCost)}`)}
                </td>
                <td className="p-3 text-right tabular-nums font-bold text-ql-success">
                  {show(view.zhipu, (p) => `¥ ${fmt(p.savings)}`)}
                </td>
                <td className="p-3 text-right tabular-nums font-semibold text-ql-success">
                  {show(view.zhipu, (p) => discountText(p.discount))}
                </td>
              </tr>
            </tbody>
            <tfoot className="bg-ql-surface-subtle font-semibold border-t border-ql-border">
              <tr>
                <td className="p-3 text-ql-fg">合计 / 加权平均</td>
                <td className="p-3 text-right tabular-nums">
                  {show(view.summary, (s) => `¥ ${fmt(s.totalPlanPrice)}`)}
                </td>
                <td className="p-3 text-right tabular-nums font-bold">
                  {show(
                    view.summary,
                    (s) => `${s.totalPlanTokensM.toFixed(2)} M (${(s.totalPlanTokensM / 100).toFixed(3)}亿)`,
                  )}
                </td>
                <td className="p-3 text-right tabular-nums font-bold text-ql-accent">
                  {show(view.summary, (s) => `¥ ${s.weightedUnitCost.toFixed(2)} / M`)}
                </td>
                <td className="p-3 text-right tabular-nums text-ql-fg-secondary">
                  {show(view.summary, (s) => `¥ ${s.blendedOfficialRate.toFixed(2)} / M`)}
                </td>
                <td className="p-3 text-right tabular-nums">
                  {show(view.summary, (s) => `¥ ${fmt(s.totalOfficialCost)}`)}
                </td>
                <td className="p-3 text-right tabular-nums font-bold text-ql-success">
                  {show(view.summary, (s) => `¥ ${fmt(s.totalPlanSavings)}`)}
                </td>
                <td className="p-3 text-right tabular-nums font-bold text-ql-success">
                  {show(view.summary, (s) => discountText(s.weightedDiscount))}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
        <p className="p-3 text-[11px] text-ql-fg-tertiary border-t border-ql-border-zone">
          {view.referenceNote}
        </p>
      </BillCard>
    </div>
  );
}
