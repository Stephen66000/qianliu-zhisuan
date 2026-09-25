import { ResourceUsageOverviewPanel } from "./ResourceUsageOverviewPanel";
import { QuotaWindowPanel } from "./QuotaWindowPanel";
import { ResourceHealthPanel } from "./ResourceHealthPanel";
import { FinanceInitializationPanel } from "./FinanceInitializationPanel";
import { formatDateTimeFull, formatDecimal } from "../../lib/format";
import type { ResourcesPageModel } from "../../pages/resources-page-model";

export function ResourceOtherTabs({ model }: { model: ResourcesPageModel }) {
  const { providerFinanceMode, activeTab, resources, forecasts, providerOptions } = model;
  return <>
      {activeTab === "usage-overview" ? (
        <div aria-labelledby="resource-tab-usage-overview" id="resource-tab-panel-usage-overview" role="tabpanel">
          <ResourceUsageOverviewPanel />
        </div>
      ) : null}

      {activeTab === "quota-windows" ? (
        <div aria-labelledby="resource-tab-quota-windows" id="resource-tab-panel-quota-windows" role="tabpanel">
          <div id="quota-windows"><QuotaWindowPanel providers={providerOptions} resources={resources} /></div>
        </div>
      ) : null}

      {activeTab === "supply-health" ? (
      <div aria-labelledby="resource-tab-supply-health" id="resource-tab-panel-supply-health" role="tabpanel">
      <section className="mt-5 rounded-xl border border-ql-border bg-ql-surface p-4" id="supply-forecasts">
        <h2 className="text-[14px] font-semibold text-ql-fg">供给预测</h2>
        {forecasts.length === 0 ? (
          <p className="mt-3 text-[13px] text-ql-fg-tertiary">暂无预测快照</p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full border-collapse text-left text-[12px]">
              <thead>
                <tr className="border-b border-ql-border text-ql-fg-tertiary">
                  <th className="p-2 font-medium">资源</th>
                  <th className="p-2 text-right font-medium">1h / 24h / 7d 速度</th>
                  <th className="p-2 font-medium">预计耗尽</th>
                  <th className="p-2 font-medium">下一恢复</th>
                  <th className="p-2 text-right font-medium">覆盖时长</th>
                  <th className="p-2 font-medium">可信度</th>
                </tr>
              </thead>
              <tbody>
                {forecasts.map((forecast) => (
                  <tr className="border-b border-ql-border-zone last:border-b-0" key={forecast.id}>
                    <td className="p-2 font-medium">{forecast.resource_name}</td>
                    <td className="p-2 text-right font-mono">
                      {forecast.rate_1h === null ? "—" : formatDecimal(forecast.rate_1h)} / {forecast.rate_24h === null ? "—" : formatDecimal(forecast.rate_24h)} /{" "}
                      {forecast.rate_7d === null ? "—" : formatDecimal(forecast.rate_7d)}
                    </td>
                    <td className="p-2">
                      {forecast.forecast_exhaust_at
                        ? formatDateTimeFull(forecast.forecast_exhaust_at)
                        : forecast.not_calculable_reason ?? "不可计算"}
                    </td>
                    <td className="p-2">
                      {forecast.next_recover_at
                        ? formatDateTimeFull(forecast.next_recover_at)
                        : "—"}
                    </td>
                    <td className="p-2 text-right font-mono">
                      {forecast.coverage_hours ? `${formatDecimal(forecast.coverage_hours)}h` : "—"}
                    </td>
                    <td className="p-2">{forecast.confidence}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <div id="resource-health"><ResourceHealthPanel providers={providerOptions} resources={resources} /></div>
      </div>
      ) : null}

      {activeTab === "finance" && providerFinanceMode !== "OFF" ? (
        <FinanceInitializationPanel
          providers={providerOptions}
          resources={resources}
        />
      ) : null}

      {/* 凭证恢复：二次确认 + 可选轮换（WT-19） */}

  </>;
}
