import { ManagementSection } from "./ManagementSection";
import { FormField, INPUT_CLASS } from "../writes/FormField";
import type { QuotaRulesPageModel } from "../../pages/quota-rules-page-model";

export function QuotaRouteSection({ model, managementOnly = false }: { model: QuotaRulesPageModel; managementOnly?: boolean }) {
  const { setSelectedModelId, archiveConfig, canCreateRoute, hasActiveModels, showRouteForm, setShowRouteForm, routeForm, selectedModelId, setSelectedRuleRouteId, models, resources, routes, setDisableRouteTarget, ruleForm, setArchiveTarget, createRoute, updateRoute } = model;
  return <>
      <ManagementSection
        hideAction={managementOnly}
        actionLabel="新建路由"
        actionDisabled={!canCreateRoute}
        hint={
          managementOnly ? "管理已有资源路由。配置价格和启用使用上方新建规则。" : canCreateRoute
            ? "第 2 步：为统一模型绑定可调用的厂商资源；启用路由后继续配置计价规则。"
            : hasActiveModels
              ? "前置条件：尚未登记厂商资源，请先到「厂商资源」页面登记。"
              : "前置条件：先在上方创建并启用统一模型，才能新建 Model Route。"
        }
        onAction={() => {
          setShowRouteForm((value) => !value);
          routeForm.setValue("unified_model_id", selectedModelId ?? "");
        }}
        title="Model Route"
      >
        <div className="mb-3 max-w-sm">
          <FormField htmlFor="route-model-filter" label="查看统一模型">
            <select
              className={`${INPUT_CLASS} w-full`}
              id="route-model-filter"
              onChange={(event) => {
                setSelectedModelId(event.target.value || null);
                setSelectedRuleRouteId("");
                ruleForm.setValue("provider_resource_id", "");
                ruleForm.setValue("upstream_model", "");
              }}
              value={selectedModelId ?? ""}
            >
              <option value="">请选择</option>
              {models.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.display_name}{model.archived_at ? "（已归档）" : ""}
                </option>
              ))}
            </select>
          </FormField>
        </div>
        {showRouteForm ? (
          <form
            className="mb-4 grid grid-cols-1 gap-3 rounded-lg border border-ql-border-zone bg-ql-surface-subtle p-4 md:grid-cols-5"
            onSubmit={routeForm.handleSubmit((values) => createRoute.mutate(values))}
          >
            <FormField
              error={routeForm.formState.errors.unified_model_id?.message}
              htmlFor="route-model"
              label="统一模型"
            >
              <select className={INPUT_CLASS} id="route-model" {...routeForm.register("unified_model_id")}>
                <option value="">请选择</option>
                {models.filter((model) => model.status === "ACTIVE" && !model.archived_at).map((model) => (
                  <option key={model.id} value={model.id}>{model.display_name}</option>
                ))}
              </select>
            </FormField>
            <FormField
              error={routeForm.formState.errors.provider_resource_id?.message}
              htmlFor="route-resource"
              label="厂商资源"
            >
              <select
                className={INPUT_CLASS}
                id="route-resource"
                {...routeForm.register("provider_resource_id")}
              >
                <option value="">请选择</option>
                {resources.map((resource) => (
                  <option key={resource.id} value={resource.id}>{resource.name}</option>
                ))}
              </select>
            </FormField>
            <FormField
              error={routeForm.formState.errors.upstream_model?.message}
              htmlFor="route-upstream"
              label="上游模型"
            >
              <input className={INPUT_CLASS} id="route-upstream" {...routeForm.register("upstream_model")} />
            </FormField>
            <FormField error={routeForm.formState.errors.priority?.message} htmlFor="route-priority" label="优先级">
              <input className={INPUT_CLASS} id="route-priority" type="number" {...routeForm.register("priority")} />
            </FormField>
            <FormField error={routeForm.formState.errors.weight?.message} htmlFor="route-weight" label="权重">
              <input className={INPUT_CLASS} id="route-weight" type="number" {...routeForm.register("weight")} />
            </FormField>
            <div className="md:col-span-5 flex justify-end">
              <button className="h-9 rounded-lg bg-ql-action px-4 text-[13px] font-medium text-white" type="submit">
                创建路由
              </button>
            </div>
          </form>
        ) : null}
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left text-[12px]">
            <thead>
              <tr className="border-b border-ql-border text-ql-fg-tertiary">
                <th className="p-2 font-medium">上游模型</th>
                <th className="p-2 font-medium">资源</th>
                <th className="p-2 text-right font-medium">优先级</th>
                <th className="p-2 text-right font-medium">权重</th>
                <th className="p-2 font-medium">状态</th>
                <th className="p-2 text-right font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {routes.map((route) => (
                <tr className="border-b border-ql-border-zone last:border-b-0" key={route.id}>
                  <td className="p-2 font-mono">{route.upstream_model}</td>
                  <td className="p-2">
                    {resources.find((resource) => resource.id === route.provider_resource_id)?.name ??
                      route.provider_resource_id}
                  </td>
                  <td className="p-2 text-right">{route.priority}</td>
                  <td className="p-2 text-right">{route.weight}</td>
                  <td className="p-2">{route.archived_at ? "已归档" : route.enabled ? "启用" : "停用"}</td>
                  <td className="p-2 text-right">
                    {route.archived_at ? (
                      <button
                        className="rounded px-2 py-1 text-ql-action hover:bg-ql-action-soft"
                        onClick={() => archiveConfig.mutate({ kind: "route", item: route, archive: false })}
                        type="button"
                      >
                        取消归档
                      </button>
                    ) : route.enabled ? (
                      <button
                        className="rounded px-2 py-1 text-ql-danger hover:bg-ql-danger-soft"
                        onClick={() => setDisableRouteTarget(route)}
                        type="button"
                      >
                        停用
                      </button>
                    ) : <>
                      <button className="rounded px-2 py-1 text-ql-action hover:bg-ql-action-soft"
                        onClick={() => updateRoute.mutate({ route, enabled: true })} type="button">启用</button>
                      <button className="rounded px-2 py-1 text-ql-fg-secondary hover:bg-ql-surface-muted"
                        onClick={() => setArchiveTarget({ kind: "route", item: route })} type="button">归档</button>
                    </>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </ManagementSection>


  </>;
}
