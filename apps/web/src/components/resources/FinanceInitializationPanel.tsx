/**
 * 资金标签页容器：按运行期状态在「初始化向导」与「日常资金面板」之间切换（WP05 任务 5.1；PFU-01）。
 *
 * 判定口径（服务端权威，`activation-state`）：
 *  - `strict_writes_enabled === false` → 尚未激活 ⇒ 展示**初始化向导**；
 *  - `strict_writes_enabled === true`  → 已激活 ⇒ 展示**日常资金面板**，并在其上方常驻
 *    **不可变激活回执**；
 *  - `mode === "OFF"` → 资金路由本身不注册，本容器不渲染任何内容（保持既有封闭语义）。
 *
 * 本容器只做「切换 + 取数」，不承载草稿逻辑；日常入账仍完全由既有 `ProviderFinancePanel`
 * 负责，避免初始化与日常两套语义互相污染。
 */
import { CircleDollarSign } from "lucide-react";
import type { ReactNode } from "react";

import { useProviderFinanceActivationState } from "../../api/provider-finance-activation";
import {
  useProviderFinanceMode,
} from "../../feature-flags";
import type { Provider, ProviderFinanceMode, ProviderResourceItem } from "../../api/types";
import { useAccess } from "../../permissions";
import { ProviderFinancePanel } from "./ProviderFinancePanel";
import { ActivationReceiptPanel } from "./ActivationReceiptPanel";
import { ProviderFinanceActivationWizard } from "./ProviderFinanceActivationWizard";
import type { ResourceOption } from "./ActivationDraftEditor";

const TAB_PANEL_ID = "resource-tab-panel-finance";
const TAB_ID = "resource-tab-finance";

function PanelShell({ children }: { children: ReactNode }) {
  return (
    <div aria-labelledby={TAB_ID} id={TAB_PANEL_ID} role="tabpanel">
      {children}
    </div>
  );
}

export function FinanceInitializationPanel({
  resources,
  providers,
}: {
  resources: ProviderResourceItem[];
  providers: Provider[];
}) {
  const contextMode: ProviderFinanceMode = useProviderFinanceMode();
  const enabled = contextMode !== "OFF";
  const state = useProviderFinanceActivationState(enabled);
  const access = useAccess();

  const providerName = (resource: ProviderResourceItem) =>
    providers.find((provider) => provider.id === resource.provider_id)?.name ?? "未知厂商";
  const resourceOptions: ResourceOption[] = resources.map((resource) => ({
    id: resource.id, mode: resource.mode, label: `${providerName(resource)} · ${resource.name}`,
  }));
  const resourceLabel = (resourceId: string): string => {
    const resource = resources.find((item) => item.id === resourceId);
    return resource ? `${providerName(resource)} · ${resource.name}` : resourceId.slice(0, 8);
  };

  // OFF：资金路由不注册，标签页也不应出现（保持既有封闭语义）。
  if (!enabled) return null;

  if (state.isLoading) {
    return (
      <PanelShell>
        <p className="rounded-xl border border-ql-border-zone bg-ql-surface p-4 text-[13px] text-ql-fg-tertiary">
          正在读取资金账本状态…
        </p>
      </PanelShell>
    );
  }

  if (state.data === undefined) {
    return (
      <PanelShell>
        <section aria-label="资金账本状态不可用" className="rounded-xl border border-ql-border-zone bg-ql-surface p-4">
          <h2 className="flex items-center gap-1.5 text-[15px] font-semibold text-ql-fg">
            <CircleDollarSign aria-hidden className="h-4 w-4" />资金账本状态不可用
          </h2>
          <p className="mt-1 text-[12px] text-ql-danger" role="alert">
            {state.error?.message ?? "未能读取资金账本状态，请稍后重试。"}
          </p>
          <button className="mt-3 rounded-lg border border-ql-border px-4 py-2 text-[13px]"
            onClick={() => void state.refetch()} type="button">
            重新读取
          </button>
        </section>
      </PanelShell>
    );
  }

  const activationState = state.data;
  // 服务端模式与前端标志不一致时以服务端为准（OFF 由服务端决定是否注册路由）。
  const serverMode: Exclude<ProviderFinanceMode, "OFF"> =
    activationState.mode === "OFF" ? contextMode : activationState.mode;

  if (activationState.strict_writes_enabled !== true) {
    return (
      <PanelShell>
        <ProviderFinanceActivationWizard
          canOperate={access.can("resources", "operate")}
          enterpriseId={access.enterpriseId ?? ""}
          mode={serverMode}
          resourceLabel={resourceLabel}
          resourceOptions={resourceOptions}
          state={activationState}
          stateUpdatedAt={state.dataUpdatedAt}
        />
      </PanelShell>
    );
  }

  return (
    <PanelShell>
      {activationState.activation_receipt ? (
        <div className="mb-4">
          <ActivationReceiptPanel activatedAt={activationState.activated_at}
            receipt={activationState.activation_receipt} />
        </div>
      ) : null}
      <ProviderFinancePanel mode={serverMode} providers={providers} resources={resources} />
    </PanelShell>
  );
}
