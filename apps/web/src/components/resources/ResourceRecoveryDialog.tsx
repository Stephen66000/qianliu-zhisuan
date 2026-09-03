import { ConfirmDialog } from "../writes/ConfirmDialog";
import { INPUT_CLASS } from "../writes/FormField";
import { STATUS_LABEL } from "./resource-page-display";
import type { ResourcesPageModel } from "../../pages/resources-page-model";

export function ResourceRecoveryDialog({ model }: { model: ResourcesPageModel }) {
  const { recoverTarget, setRecoverTarget, rotateCredential, setRotateCredential, newCredential, setNewCredential, recoverMutation } = model;
  return <>
      <ConfirmDialog
        confirmLabel="确认恢复"
        impact={`恢复「${recoverTarget?.name}」将从隔离状态（${STATUS_LABEL[recoverTarget?.status ?? ""] ?? recoverTarget?.status}）转为降级观察，恢复为路由候选。${rotateCredential ? "同时将轮换凭证（旧凭证立即失效）。" : "不轮换凭证。"}`}
        loading={recoverMutation.isPending}
        onCancel={() => {
          setRecoverTarget(null);
          setRotateCredential(false);
          setNewCredential("");
        }}
        onConfirm={() => recoverTarget && recoverMutation.mutate(recoverTarget)}
        open={recoverTarget !== null}
        title="恢复资源"
      >
        <label className="flex items-center gap-2 text-[13px] text-ql-fg">
          <input
            checked={rotateCredential}
            onChange={(e) => setRotateCredential(e.target.checked)}
            type="checkbox"
          />
          同时轮换凭证（旧凭证立即失效）
        </label>
        {rotateCredential ? (
          <input
            autoComplete="off"
            className={`${INPUT_CLASS} mt-2 w-full`}
            onChange={(e) => setNewCredential(e.target.value)}
            placeholder="新凭证明文（仅一次提交）"
            type="password"
            value={newCredential}
          />
        ) : null}
      </ConfirmDialog>
  </>;
}
