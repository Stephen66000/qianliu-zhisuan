import { useEffect } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";

export type ResourceTab = "utilization" | "usage-overview" | "quota-windows" | "supply-health" | "finance";

const RESOURCE_TABS: Array<{ id: ResourceTab; label: string }> = [
  { id: "utilization", label: "资源利用" },
  { id: "usage-overview", label: "用量总览" },
  { id: "quota-windows", label: "额度窗口" },
  { id: "supply-health", label: "供给与健康" },
  { id: "finance", label: "充值与订阅" },
];

function tabFromLocation(requested: string | null, hash: string, financeEnabled: boolean): ResourceTab {
  if (RESOURCE_TABS.some((tab) => tab.id === requested)
    && (requested !== "finance" || financeEnabled)) return requested as ResourceTab;
  if (hash === "#quota-windows") return "quota-windows";
  if (hash === "#supply-forecasts" || hash === "#resource-health" || hash.startsWith("#health-")) {
    return "supply-health";
  }
  return "utilization";
}

export function useResourceTab(financeEnabled = false) {
  const location = useLocation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const activeTab = tabFromLocation(searchParams.get("tab"), location.hash, financeEnabled);
  const selectTab = (tab: ResourceTab) => {
    const next = new URLSearchParams(searchParams);
    if (tab === "utilization") next.delete("tab");
    else next.set("tab", tab);
    void navigate({
      pathname: location.pathname,
      search: next.toString() ? `?${next.toString()}` : "",
      hash: "",
    });
  };
  useEffect(() => {
    if (activeTab !== "supply-health" || !location.hash) return;
    const target = document.getElementById(location.hash.slice(1));
    if (target && typeof target.scrollIntoView === "function") {
      target.scrollIntoView({ block: "start" });
    }
  }, [activeTab, location.hash]);
  return { activeTab, selectTab };
}

export function ResourceTabs({
  activeTab,
  onSelect,
  showFinance = false,
}: {
  activeTab: ResourceTab;
  onSelect: (tab: ResourceTab) => void;
  showFinance?: boolean;
}) {
  return (
    <div aria-label="厂商资源视图" className="mb-5 flex gap-2 overflow-x-auto border-b border-ql-border" role="tablist">
      {RESOURCE_TABS.filter((tab) => tab.id !== "finance" || showFinance).map((tab) => (
        <button
          aria-controls={`resource-tab-panel-${tab.id}`}
          aria-selected={activeTab === tab.id}
          className={`whitespace-nowrap border-b-2 px-4 py-2 text-[13px] ${activeTab === tab.id ? "border-ql-brand text-ql-brand" : "border-transparent text-ql-fg-secondary"}`}
          id={`resource-tab-${tab.id}`}
          key={tab.id}
          onClick={() => onSelect(tab.id)}
          role="tab"
          type="button"
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}
