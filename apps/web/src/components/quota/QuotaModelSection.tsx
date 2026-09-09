import { ManagementSection } from "./ManagementSection";
import { FormField, INPUT_CLASS } from "../writes/FormField";
import type { QuotaRulesPageModel } from "../../pages/quota-rules-page-model";

export function QuotaModelSection({ model, managementOnly = false }: { model: QuotaRulesPageModel; managementOnly?: boolean }) {
  const { showModelForm, setShowModelForm, modelForm, visibleModels, setSelectedModelId, archiveConfig, setDisableModelTarget, updateModel, setArchiveTarget, createModel } = model;
  return <>
      <ManagementSection
        hideAction={managementOnly}
        actionLabel="新建统一模型"
        hint={managementOnly ? "管理已有模型的停用、归档与恢复。新配置使用上方新建规则。" : "第 1 步：先定义对客户端稳定暴露的统一模型；创建后继续配置 Model Route。"}
        onAction={() => setShowModelForm((value) => !value)}
        title="统一模型"
      >
        {showModelForm ? (
          <form data-write-action
            className="mb-4 grid grid-cols-1 gap-3 rounded-lg border border-ql-border-zone bg-ql-surface-subtle p-4 sm:grid-cols-2"
            onSubmit={modelForm.handleSubmit((values) => createModel.mutate(values))}
          >
            <FormField error={modelForm.formState.errors.alias?.message} htmlFor="model-alias" label="模型别名">
              <input className={INPUT_CLASS} id="model-alias" {...modelForm.register("alias")} />
            </FormField>
            <FormField
              error={modelForm.formState.errors.display_name?.message}
              htmlFor="model-display-name"
              label="显示名称"
            >
              <input className={INPUT_CLASS} id="model-display-name" {...modelForm.register("display_name")} />
            </FormField>
            <div className="sm:col-span-2 flex justify-end">
              <button data-write-action className="h-9 rounded-lg bg-ql-action px-4 text-[13px] font-medium text-white" type="submit">
                创建模型
              </button>
            </div>
          </form>
        ) : null}
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left text-[12px]">
            <thead>
              <tr className="border-b border-ql-border text-ql-fg-tertiary">
                <th className="p-2 font-medium">别名</th>
                <th className="p-2 font-medium">名称</th>
                <th className="p-2 font-medium">状态</th>
                <th className="p-2 text-right font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {visibleModels.map((model) => (
                <tr className="border-b border-ql-border-zone last:border-b-0" key={model.id}>
                  <td className="p-2 font-mono">{model.alias}</td>
                  <td className="p-2">{model.display_name}</td>
                  <td className="p-2">{model.archived_at ? "已归档" : model.status === "ACTIVE" ? "启用" : model.status === "PENDING_CONFIG" ? "待配置" : "停用"}</td>
                  <td className="p-2 text-right">
                    <button
                      className="rounded px-2 py-1 text-ql-action hover:bg-ql-action-soft"
                      onClick={() => setSelectedModelId(model.id)}
                      type="button"
                    >
                      管理路由
                    </button>
                    {model.archived_at ? (
                      <button data-write-action
                        className="rounded px-2 py-1 text-ql-action hover:bg-ql-action-soft"
                        onClick={() => archiveConfig.mutate({ kind: "model", item: model, archive: false })}
                        type="button"
                      >
                        取消归档
                      </button>
                    ) : model.status === "ACTIVE" ? (
                      <button
                        className="rounded px-2 py-1 text-ql-danger hover:bg-ql-danger-soft"
                        onClick={() => setDisableModelTarget(model)}
                        type="button"
                      >
                        停用
                      </button>
                    ) : model.status === "PENDING_CONFIG" ? (
                      <button data-write-action className="rounded px-2 py-1 text-ql-action hover:bg-ql-action-soft" onClick={() => updateModel.mutate({ model, status: "ACTIVE" })} type="button">启用</button>
                    ) : (
                      <button
                        className="rounded px-2 py-1 text-ql-fg-secondary hover:bg-ql-surface-muted"
                        onClick={() => setArchiveTarget({ kind: "model", item: model })}
                        type="button"
                      >
                        归档
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </ManagementSection>


  </>;
}
