import type { BillingRule, DispatchPolicy, ModelRouteItem, Principal, UnifiedModel } from "../../api/types";
import { ConfirmDialog } from "../writes/ConfirmDialog";
import { policyTransitionImpact } from "./PrincipalScopeField";

export type ArchiveTarget =
  | { kind: "model"; item: UnifiedModel }
  | { kind: "route"; item: ModelRouteItem }
  | { kind: "rule"; item: BillingRule };

export type PolicyActionTarget = {
  policy: DispatchPolicy;
  action: "publish" | "retire" | "restore" | "archive";
};

function archiveTitle(target: ArchiveTarget | null): string {
  if (target?.kind === "model") return "确认归档统一模型？";
  if (target?.kind === "route") return "确认归档 Model Route？";
  return "确认归档计价规则？";
}

function policyLabel(target: PolicyActionTarget | null): string {
  if (target?.action === "archive") return "确认存档";
  if (target?.action === "publish") return "确认发布";
  if (target?.action === "restore") return "确认恢复并发布";
  return "确认停用";
}

function policyTitle(target: PolicyActionTarget | null): string {
  if (target?.action === "archive") return "存档调度策略";
  if (target?.action === "publish") return "发布调度策略";
  if (target?.action === "restore") return "恢复调度策略原配置";
  return "停用调度策略";
}

export function ConfigurationActionDialogs(props: {
  archiveTarget: ArchiveTarget | null;
  archiveLoading: boolean;
  onArchiveCancel: () => void;
  onArchiveConfirm: (target: ArchiveTarget) => void;
  policyTarget: PolicyActionTarget | null;
  policyLoading: boolean;
  principalById: Map<string, Principal>;
  onPolicyCancel: () => void;
  onPolicyConfirm: (target: PolicyActionTarget) => void;
}) {
  const policyImpact = props.policyTarget?.action === "archive"
    ? "已停用策略将从默认列表隐藏，可在查看存档中找到，历史决策与审计继续保留。"
    : props.policyTarget?.action === "restore"
    ? `将基于历史版本 ${props.policyTarget.policy.policyVersion} 自动校验并生成递增的新发布版本；历史版本继续保持 RETIRED。`
    : policyTransitionImpact(props.policyTarget, props.principalById);
  return <>
    <ConfirmDialog cancelLabel="取消" confirmLabel="确认归档" danger
      impact="归档后，该模型将从默认列表和新配置入口中隐藏。可通过‘查看已归档配置’恢复。是否继续？"
      loading={props.archiveLoading} onCancel={props.onArchiveCancel}
      onConfirm={() => props.archiveTarget && props.onArchiveConfirm(props.archiveTarget)}
      open={props.archiveTarget !== null} title={archiveTitle(props.archiveTarget)} />
    <ConfirmDialog danger={props.policyTarget?.action === "retire"}
      confirmLabel={policyLabel(props.policyTarget)} impact={policyImpact}
      loading={props.policyLoading} onCancel={props.onPolicyCancel}
      onConfirm={() => props.policyTarget && props.onPolicyConfirm(props.policyTarget)}
      open={props.policyTarget !== null} title={policyTitle(props.policyTarget)} />
  </>;
}
