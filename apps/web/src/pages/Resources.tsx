import { PageShell } from "../components/layout/PageShell";
import { ResourceTabs } from "../components/resources/ResourceTabs";
import { ResourceOnboardingSection } from "../components/resources/ResourceOnboardingSection";
import { ResourceDialogs } from "../components/resources/ResourceDialogs";
import { ResourceTable } from "../components/resources/ResourceTable";
import { ResourceOtherTabs } from "../components/resources/ResourceOtherTabs";
import { ResourceRecoveryDialog } from "../components/resources/ResourceRecoveryDialog";
import { useResourcesPageModel } from "./resources-page-model";

export function ResourcesPage() {
  const model = useResourcesPageModel();
  return (
    <PageShell description="厂商 API 与 Coding Plan 资源、资金账本、凭证安全与受控恢复" title="厂商资源">
      <ResourceTabs activeTab={model.activeTab} onSelect={model.selectTab} showFinance={model.providerFinanceMode !== "OFF"} />
      {model.activeTab === "utilization" ? (
        <div aria-labelledby="resource-tab-utilization" id="resource-tab-panel-utilization" role="tabpanel">
          <ResourceOnboardingSection model={model} />
          <ResourceDialogs model={model} />
          <ResourceTable model={model} />
        </div>
      ) : null}
      <ResourceOtherTabs model={model} />
      <ResourceRecoveryDialog model={model} />
    </PageShell>
  );
}
