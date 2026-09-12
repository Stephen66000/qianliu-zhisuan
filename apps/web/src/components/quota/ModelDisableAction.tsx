import { useState } from "react";
import { INPUT_CLASS } from "../writes/FormField";
import type { QuotaRulesPageModel } from "../../pages/quota-rules-page-model";
import { useAccess } from "../../permissions";

export function ModelDisableAction({ model, inline = false }: { model: QuotaRulesPageModel; inline?: boolean }) {
  const [selectedId, setSelectedId] = useState("");
  const access = useAccess();
  const mayDisable = access.can("quota", "operate") && access.can("resources", "operate");
  const models = model.visibleModels;
  const selected = models.find((item) => item.id === selectedId);
  const busy = model.updateModel.isPending || model.archiveConfig.isPending;
  const status = selected?.archived_at ? "已存档（保持停用）" : selected?.status === "DISABLED" ? "已停用"
    : selected?.status === "ACTIVE" ? "启用中" : selected ? "待配置" : "";

  const containerClass = inline
    ? "flex flex-wrap items-center gap-1.5"
    : "mb-4 flex flex-wrap items-center gap-2 rounded-lg border border-ql-border-zone p-3";

  const selectClass = inline
    ? "h-8 max-w-[200px] rounded-md border border-ql-border bg-ql-surface px-2 text-[12px] text-ql-fg focus:border-ql-action focus:outline-none"
    : `${INPUT_CLASS} max-w-md`;

  const btnBaseClass = inline
    ? "h-8 rounded-md border px-2.5 text-[12px]"
    : "h-9 rounded-lg border px-3 text-[12px]";

  return (
    <div data-write-action className={containerClass}>
      <label htmlFor="disable-pricing-model" className="text-[12px] font-medium text-ql-fg-secondary whitespace-nowrap">
        模型调整：
      </label>
      <select
        id="disable-pricing-model"
        aria-label="模型管理"
        className={selectClass}
        value={selected?.id ?? ""}
        disabled={model.modelsQuery.isLoading || busy}
        onChange={(event) => {
          setSelectedId(event.target.value);
          model.updateModel.reset();
          model.archiveConfig.reset();
        }}
      >
        <option value="">{model.showArchived ? "请选择已存档模型" : "请选择要操作的模型"}</option>
        {models.map((item) => (
          <option key={item.id} value={item.id}>
            {item.display_name}（{item.alias}）
          </option>
        ))}
      </select>
      {model.showArchived ? (
        <button
          data-write-action
          type="button"
          className={`${btnBaseClass} border-ql-border text-ql-action disabled:opacity-50 hover:bg-ql-action-soft`}
          title="取消存档仅恢复显示，不会自动启用"
          disabled={!mayDisable || !selected?.archived_at || busy}
          onClick={() => {
            if (selected) model.archiveConfig.mutate({ kind: "model", item: selected, archive: false });
          }}
        >
          取消存档
        </button>
      ) : (
        <>
          <button
            data-write-action
            type="button"
            className={`${btnBaseClass} border-ql-danger text-ql-danger disabled:opacity-50 hover:bg-red-50`}
            title={mayDisable ? undefined : "需要额度规则和厂商资源的操作权限"}
            disabled={!mayDisable || !selected || selected.status !== "ACTIVE" || busy}
            onClick={() => {
              if (selected) model.setDisableModelTarget(selected);
            }}
          >
            停用模型
          </button>
          <button
            data-write-action
            type="button"
            className={`${btnBaseClass} border-ql-border text-ql-fg-secondary disabled:opacity-50 hover:bg-ql-surface-muted`}
            title="模型必须先停用才能存档"
            disabled={!mayDisable || !selected || selected.status !== "DISABLED" || busy}
            onClick={() => {
              if (selected) model.setArchiveTarget({ kind: "model", item: selected });
            }}
          >
            存档模型
          </button>
        </>
      )}
      <span role="status" className="text-[12px] font-medium text-ql-fg-secondary">
        {status}
      </span>
    </div>
  );
}
