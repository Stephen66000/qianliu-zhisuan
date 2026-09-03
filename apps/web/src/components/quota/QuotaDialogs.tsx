import { ConfigurationActionDialogs } from "./ConfigurationActionDialogs";
import { ConfirmDialog } from "../writes/ConfirmDialog";
import type { QuotaRulesPageModel } from "../../pages/quota-rules-page-model";

export function QuotaDialogs({ model }: { model: QuotaRulesPageModel }) {
  const { archiveConfig, setDisableModelTarget, updateModel, updateRoute, setDisableRouteTarget, setArchiveTarget, setPolicyActionTarget, transitionPolicy, archiveTarget, policyActionTarget, principalById, disableModelTarget, disableRouteTarget } = model;
  return <>
      <ConfigurationActionDialogs archiveLoading={archiveConfig.isPending} archiveTarget={archiveTarget}
        onArchiveCancel={() => setArchiveTarget(null)} onArchiveConfirm={target => archiveConfig.mutate({ ...target, archive: true } as Parameters<typeof archiveConfig.mutate>[0])}
        onPolicyCancel={() => setPolicyActionTarget(null)} onPolicyConfirm={target => transitionPolicy.mutate(target)} policyLoading={transitionPolicy.isPending} policyTarget={policyActionTarget} principalById={principalById} />
      <ConfirmDialog
        danger
        confirmLabel="确认停用"
        impact={`停用统一模型「${disableModelTarget?.display_name ?? ""}」后，新请求不能再选择该模型。`}
        loading={updateModel.isPending}
        onCancel={() => setDisableModelTarget(null)}
        onConfirm={() =>
          disableModelTarget &&
          updateModel.mutate({ model: disableModelTarget, status: "DISABLED" })
        }
        open={disableModelTarget !== null}
        title="停用统一模型"
      />
      <ConfirmDialog
        danger
        confirmLabel="确认停用"
        impact={`停用路由 ${disableRouteTarget?.upstream_model ?? ""} 后，调度不再选择该候选。`}
        loading={updateRoute.isPending}
        onCancel={() => setDisableRouteTarget(null)}
        onConfirm={() =>
          disableRouteTarget && updateRoute.mutate({ route: disableRouteTarget, enabled: false })
        }
        open={disableRouteTarget !== null}
        title="停用 Model Route"
      />
  </>;
}
