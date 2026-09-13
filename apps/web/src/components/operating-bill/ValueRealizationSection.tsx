import { useMemo } from "react";
import type { OperatingAnalysis } from "../../api/operating-analysis";
import { BillCard, SectionHeading } from "./BillShared";
import { formatMoney } from "../../lib/format";

const fmt = (v: number | string) =>
  typeof v === "number" ? formatMoney(v.toFixed(2)) : formatMoney(v);

interface ValueRealizationSectionProps {
  analysis?: OperatingAnalysis;
  month: string;
}

export function ValueRealizationSection({ analysis, month }: ValueRealizationSectionProps) {
  const activeCount = useMemo(() => {
    const current = analysis?.months.find((m) => m.month === month);
    return current?.activeEmployees ?? 6;
  }, [analysis, month]);

  // 从 analysis 或既定套餐中提取数据
  const valueData = useMemo(() => {
    // Kimi
    const kimiTokensRaw = analysis?.plans.find((p) => p.providerCode === "kimi")
      ?.months.find((m) => m.month === month)?.totalTokens ?? "50000000";
    const kimiTokensM = Math.max(1, Number(kimiTokensRaw) / 1_000_000);
    const kimiPrice = 199.0;
    const kimiOfficialRate = 12.0; // 官方 API 参考单价 ¥12/M
    const kimiUnitCost = kimiPrice / kimiTokensM;
    const kimiOfficialCost = kimiTokensM * kimiOfficialRate;
    const kimiSavings = Math.max(0, kimiOfficialCost - kimiPrice);
    const kimiDiscount = (kimiUnitCost / kimiOfficialRate) * 10;

    // 智谱
    const zhipuTokensRaw = analysis?.plans.find((p) => p.providerCode === "zhipu")
      ?.months.find((m) => m.month === month)?.totalTokens ?? "92500000";
    const zhipuTokensM = Math.max(1, Number(zhipuTokensRaw) / 1_000_000);
    const zhipuPrice = 422.1;
    const zhipuOfficialRate = 15.0; // 官方 API 参考单价 ¥15/M
    const zhipuUnitCost = zhipuPrice / zhipuTokensM;
    const zhipuOfficialCost = zhipuTokensM * zhipuOfficialRate;
    const zhipuSavings = Math.max(0, zhipuOfficialCost - zhipuPrice);
    const zhipuDiscount = (zhipuUnitCost / zhipuOfficialRate) * 10;

    // 账号复用
    const kimiAccountCost = 199.0;
    const zhipuAccountCost = 422.1;
    const kimiUsers = Math.max(1, activeCount);
    const zhipuUsers = Math.max(1, Math.min(activeCount, 5));

    const kimiSavedAccounts = Math.max(0, kimiUsers - 1);
    const zhipuSavedAccounts = Math.max(0, zhipuUsers - 1);
    const totalSavedAccounts = kimiSavedAccounts + zhipuSavedAccounts;

    const kimiSavedMoney = kimiSavedAccounts * kimiAccountCost;
    const zhipuSavedMoney = zhipuSavedAccounts * zhipuAccountCost;
    const totalSavedMoney = kimiSavedMoney + zhipuSavedMoney;

    const avgMultiplexRatio = ((kimiUsers + zhipuUsers) / 2).toFixed(1);

    const totalPlanTokensM = kimiTokensM + zhipuTokensM;
    const totalPlanPrice = kimiPrice + zhipuPrice;
    const weightedUnitCost = totalPlanPrice / totalPlanTokensM;
    const totalOfficialCost = kimiOfficialCost + zhipuOfficialCost;
    const totalPlanSavings = totalOfficialCost - totalPlanPrice;
    const weightedDiscount = (weightedUnitCost / ((kimiOfficialRate + zhipuOfficialRate) / 2)) * 10;

    return {
      activeCount,
      totalSavedMoney,
      avgMultiplexRatio,
      weightedUnitCost,
      weightedDiscount,
      totalPlanSavings,
      kimi: {
        users: kimiUsers,
        savedAccounts: kimiSavedAccounts,
        savedMoney: kimiSavedMoney,
        price: kimiPrice,
        tokensM: kimiTokensM,
        unitCost: kimiUnitCost,
        officialRate: kimiOfficialRate,
        officialCost: kimiOfficialCost,
        savings: kimiSavings,
        discount: kimiDiscount,
      },
      zhipu: {
        users: zhipuUsers,
        savedAccounts: zhipuSavedAccounts,
        savedMoney: zhipuSavedMoney,
        price: zhipuPrice,
        tokensM: zhipuTokensM,
        unitCost: zhipuUnitCost,
        officialRate: zhipuOfficialRate,
        officialCost: zhipuOfficialCost,
        savings: zhipuSavings,
        discount: zhipuDiscount,
      },
      summary: {
        totalSavedAccounts,
        totalPlanPrice,
        totalPlanTokensM,
        totalOfficialCost,
      },
    };
  }, [analysis, month, activeCount]);

  return (
    <div className="space-y-5" role="region" aria-label="价值体现">
      {/* 顶部四大价值指标卡 */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-xl border border-ql-border bg-ql-surface p-4 shadow-sm">
          <div className="text-xs text-ql-fg-secondary mb-1">当月账号等效少购节约</div>
          <div className="text-2xl font-bold text-ql-success tabular-nums">
            ¥ {fmt(valueData.totalSavedMoney)}
          </div>
          <div className="text-[11px] text-ql-fg-tertiary mt-1">
            少购 {valueData.summary.totalSavedAccounts} 个账号（Kimi ¥{fmt(valueData.kimi.savedMoney)} + 智谱 ¥{fmt(valueData.zhipu.savedMoney)}）
          </div>
        </div>

        <div className="rounded-xl border border-ql-border bg-ql-surface p-4 shadow-sm">
          <div className="text-xs text-ql-fg-secondary mb-1">账号平均复用倍比</div>
          <div className="text-2xl font-bold text-ql-action tabular-nums">
            {valueData.avgMultiplexRatio}x
          </div>
          <div className="text-[11px] text-ql-fg-tertiary mt-1">
            各买 1 个账号，平稳保障 {valueData.activeCount} 人高频共享使用
          </div>
        </div>

        <div className="rounded-xl border border-ql-border bg-ql-surface p-4 shadow-sm">
          <div className="text-xs text-ql-fg-secondary mb-1">Coding Plan 实际摊薄单价</div>
          <div className="text-2xl font-bold text-ql-accent tabular-nums">
            ¥ {valueData.weightedUnitCost.toFixed(2)}{" "}
            <span className="text-xs font-normal text-ql-fg-secondary">/ 百万 Token</span>
          </div>
          <div className="text-[11px] text-ql-fg-tertiary mt-1">
            较官方同级 API 市价相当于{" "}
            <span className="font-semibold text-ql-success">
              {valueData.weightedDiscount.toFixed(1)} 折
            </span>
          </div>
        </div>

        <div className="rounded-xl border border-ql-border bg-ql-surface p-4 shadow-sm">
          <div className="text-xs text-ql-fg-secondary mb-1">Coding Plan 等效采购降本</div>
          <div className="text-2xl font-bold text-ql-success tabular-nums">
            ¥ {fmt(valueData.totalPlanSavings)}
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
            少购 {valueData.summary.totalSavedAccounts} 个独立账号 · 月度净省 ¥{fmt(valueData.totalSavedMoney)}
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
                  {valueData.kimi.users} 人 (全员)
                </td>
                <td className="p-3 text-right tabular-nums font-bold text-ql-success">
                  {(valueData.kimi.users / 1).toFixed(1)}x
                </td>
                <td className="p-3 text-right tabular-nums text-ql-success">
                  {valueData.kimi.savedAccounts} 个
                </td>
                <td className="p-3 text-right tabular-nums">¥ {fmt(valueData.kimi.price)}</td>
                <td className="p-3 text-right tabular-nums font-bold text-ql-success">
                  ¥ {fmt(valueData.kimi.savedMoney)}
                </td>
                <td className="p-3 text-right text-ql-fg-secondary">支撑良好，可满足 6~8 人使用</td>
              </tr>
              <tr className="hover:bg-ql-surface-subtle">
                <td className="p-3 font-semibold text-ql-fg">智谱 Coding Plan</td>
                <td className="p-3 text-right tabular-nums">1 个</td>
                <td className="p-3 text-right tabular-nums font-semibold text-ql-action">
                  {valueData.zhipu.users} 人
                </td>
                <td className="p-3 text-right tabular-nums font-bold text-ql-success">
                  {(valueData.zhipu.users / 1).toFixed(1)}x
                </td>
                <td className="p-3 text-right tabular-nums text-ql-success">
                  {valueData.zhipu.savedAccounts} 个
                </td>
                <td className="p-3 text-right tabular-nums">¥ {fmt(valueData.zhipu.price)}</td>
                <td className="p-3 text-right tabular-nums font-bold text-ql-success">
                  ¥ {fmt(valueData.zhipu.savedMoney)}
                </td>
                <td className="p-3 text-right text-ql-fg-secondary">支撑良好，可满足 6~8 人使用</td>
              </tr>
              <tr className="hover:bg-ql-surface-subtle">
                <td className="p-3 font-semibold text-ql-fg">DeepSeek (API 集中托管)</td>
                <td className="p-3 text-right tabular-nums">1 个企业 Key</td>
                <td className="p-3 text-right tabular-nums font-semibold text-ql-action">
                  {valueData.activeCount} 人 (全员)
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
                <td className="p-3 text-right tabular-nums">{valueData.activeCount} 人使用</td>
                <td className="p-3 text-right tabular-nums font-bold text-ql-success">
                  {valueData.avgMultiplexRatio}x
                </td>
                <td className="p-3 text-right tabular-nums font-bold text-ql-success">
                  {valueData.summary.totalSavedAccounts} 个账号
                </td>
                <td className="p-3 text-right tabular-nums">¥ {fmt(valueData.summary.totalPlanPrice)}</td>
                <td className="p-3 text-right tabular-nums font-bold text-ql-success">
                  ¥ {fmt(valueData.totalSavedMoney)}
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
            实际 Token 摊薄单价低至 {valueData.weightedDiscount.toFixed(1)} 折
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
                <td className="p-3 text-right tabular-nums">¥ {fmt(valueData.kimi.price)}</td>
                <td className="p-3 text-right tabular-nums font-medium">
                  {valueData.kimi.tokensM.toFixed(2)} M ({(valueData.kimi.tokensM * 100).toFixed(0)}万)
                </td>
                <td className="p-3 text-right tabular-nums font-bold text-ql-accent">
                  ¥ {valueData.kimi.unitCost.toFixed(2)} / M
                </td>
                <td className="p-3 text-right tabular-nums text-ql-fg-secondary">
                  ¥ {valueData.kimi.officialRate.toFixed(2)} / M
                </td>
                <td className="p-3 text-right tabular-nums">
                  ¥ {fmt(valueData.kimi.officialCost)}
                </td>
                <td className="p-3 text-right tabular-nums font-bold text-ql-success">
                  ¥ {fmt(valueData.kimi.savings)}
                </td>
                <td className="p-3 text-right tabular-nums font-semibold text-ql-success">
                  {valueData.kimi.discount.toFixed(1)} 折 (-{(100 - valueData.kimi.discount * 10).toFixed(1)}%)
                </td>
              </tr>
              <tr className="hover:bg-ql-surface-subtle">
                <td className="p-3 font-semibold text-ql-fg">智谱 Coding Plan</td>
                <td className="p-3 text-right tabular-nums">¥ {fmt(valueData.zhipu.price)}</td>
                <td className="p-3 text-right tabular-nums font-medium">
                  {valueData.zhipu.tokensM.toFixed(2)} M ({(valueData.zhipu.tokensM * 100).toFixed(0)}万)
                </td>
                <td className="p-3 text-right tabular-nums font-bold text-ql-accent">
                  ¥ {valueData.zhipu.unitCost.toFixed(2)} / M
                </td>
                <td className="p-3 text-right tabular-nums text-ql-fg-secondary">
                  ¥ {valueData.zhipu.officialRate.toFixed(2)} / M
                </td>
                <td className="p-3 text-right tabular-nums">
                  ¥ {fmt(valueData.zhipu.officialCost)}
                </td>
                <td className="p-3 text-right tabular-nums font-bold text-ql-success">
                  ¥ {fmt(valueData.zhipu.savings)}
                </td>
                <td className="p-3 text-right tabular-nums font-semibold text-ql-success">
                  {valueData.zhipu.discount.toFixed(1)} 折 (-{(100 - valueData.zhipu.discount * 10).toFixed(1)}%)
                </td>
              </tr>
            </tbody>
            <tfoot className="bg-ql-surface-subtle font-semibold border-t border-ql-border">
              <tr>
                <td className="p-3 text-ql-fg">合计 / 加权平均</td>
                <td className="p-3 text-right tabular-nums">¥ {fmt(valueData.summary.totalPlanPrice)}</td>
                <td className="p-3 text-right tabular-nums font-bold">
                  {valueData.summary.totalPlanTokensM.toFixed(2)} M ({(valueData.summary.totalPlanTokensM / 100).toFixed(3)}亿)
                </td>
                <td className="p-3 text-right tabular-nums font-bold text-ql-accent">
                  ¥ {valueData.weightedUnitCost.toFixed(2)} / M
                </td>
                <td className="p-3 text-right tabular-nums text-ql-fg-secondary">
                  ¥ {((valueData.kimi.officialRate + valueData.zhipu.officialRate) / 2).toFixed(2)} / M
                </td>
                <td className="p-3 text-right tabular-nums">
                  ¥ {fmt(valueData.summary.totalOfficialCost)}
                </td>
                <td className="p-3 text-right tabular-nums font-bold text-ql-success">
                  ¥ {fmt(valueData.totalPlanSavings)}
                </td>
                <td className="p-3 text-right tabular-nums font-bold text-ql-success">
                  {valueData.weightedDiscount.toFixed(1)} 折 (-{(100 - valueData.weightedDiscount * 10).toFixed(1)}%)
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      </BillCard>
    </div>
  );
}
