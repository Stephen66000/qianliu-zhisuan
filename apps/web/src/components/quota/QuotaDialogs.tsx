import { ConfigurationActionDialogs } from "./ConfigurationActionDialogs";
import { ConfirmDialog } from "../writes/ConfirmDialog";
import type { QuotaRulesPageModel } from "../../pages/quota-rules-page-model";

export function QuotaDialogs({ model }: { model: QuotaRulesPageModel }) {
  const { archiveConfig, setDisableModelTarget, updateModel, updateRoute, setDisableRouteTarget, setArchiveTarget, setPolicyActionTarget, transitionPolicy, archiveTarget, policyActionTarget, principalById, disableModelTarget, disableRouteTarget } = model;
  return <>
      <ConfigurationActionDialogs archiveLoading={archiveConfig.isPending} archiveTarget={archiveTarget}
        onArchiveCancel={() => { if (!archiveConfig.isPending) setArchiveTarget(null); }} onArchiveConfirm={target => archiveConfig.mutate({ ...target, archive: true } as Parameters<typeof archiveConfig.mutate>[0])}
        onPolicyCancel={() => setPolicyActionTarget(null)} onPolicyConfirm={target => transitionPolicy.mutate(target)} policyLoading={transitionPolicy.isPending} policyTarget={policyActionTarget} principalById={principalById} />
      <ConfirmDialog
        danger
        confirmLabel="确认停用"
        impact={`停用统一模型「${disableModelTarget?.display_name ?? ""}」（${disableModelTarget?.alias ?? ""}）后，所有主体对该模型的新调用将被阻止。其他模型不受影响；历史用量、账本和价格记录保留。已发出的上游请求不保证中止。`}
        loading={updateModel.isPending}
        onCancel={() => { if (!updateModel.isPending) setDisableModelTarget(null); }}
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
