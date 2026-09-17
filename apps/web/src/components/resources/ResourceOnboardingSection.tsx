import { Plus } from "lucide-react";
import type { ProviderResourceItem } from "../../api/types";
import { CreateModelDiscoveryPanel } from "./ResourceModelDiscovery";
import { ResourceUtilizationPanel } from "./ResourceUtilizationPanel";
import { ProviderManagementDialog } from "./ProviderManagementDialog";
import { FormField, INPUT_CLASS } from "../writes/FormField";
import { IntegerAmountInput } from "../writes/IntegerAmountInput";
import {
  API_OPERATING_KEYS,
  PLAN_OPERATING_KEYS,
  formatResourceNameWithDate,
  type CreateResourceValues,
} from "./resource-form-contract";
import type { ResourcesPageModel } from "../../pages/resources-page-model";

export function ResourceOnboardingSection({ model }: { model: ResourcesPageModel }) {
  const { featureFlags, showCreate, setShowCreate, showNewProvider, setShowNewProvider, showManageProviders, setShowManageProviders, discovery, setDiscovery, selectedModelIds, setSelectedModelIds, createValidationError, setCreateValidationError, createMutation, createProviderMutation, newProviderName, setNewProviderName, newProviderCode, setNewProviderCode, register, handleSubmit, getValues, reset, setValue, errors, createMode, createResetCycle, createTotalQuota, resources, providerOptions, clearCreateDiscovery } = model;
  return <>
      <div className="mb-4 flex justify-end">
        <button
          className="flex h-9 items-center gap-1.5 rounded-lg bg-ql-action px-4 text-[14px] font-medium text-white hover:bg-ql-action-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ql-action"
          onClick={() => setShowCreate((v) => !v)}
          type="button"
        >
          <Plus aria-hidden className="h-4 w-4" />
          登记资源
        </button>
      </div>

      {featureFlags.FEATURE_RESOURCE_UTILIZATION_V2
        ? <ResourceUtilizationPanel resources={resources} />
        : null}

      {showCreate ? (
        <form data-write-action
          className="mb-5 flex flex-col gap-4 rounded-xl border border-ql-border bg-ql-surface-subtle p-4"
          onSubmit={handleSubmit((values) => {
            if (!discovery || selectedModelIds.length === 0) {
              setCreateValidationError("请先检测并选择至少一个兼容模型");
              return;
            }
            setCreateValidationError("");
            const finalValues = {
              ...values,
              name: formatResourceNameWithDate(values.name),
            };
            createMutation.mutate(finalValues);
          })}
        >
          <div className="rounded-lg border border-ql-border bg-ql-surface px-3 py-2 text-[12px] text-ql-fg-secondary">
            第 1 步填写资源与凭证 → 第 2 步服务端检测模型 → 第 3 步选择兼容模型 → 第 4 步确认接入。
            系统会自动创建或复用统一模型和路由，但不会扩大任何员工 Key 权限。
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <FormField error={errors.provider_id?.message} htmlFor="res-provider" label="厂商">
              <div className="flex gap-2">
                <select className={`${INPUT_CLASS} flex-1`} id="res-provider" {...register("provider_id", {
                  onChange: (e) => {
                    clearCreateDiscovery();
                    const selectedId = e.target.value;
                    const provider = providerOptions.find((p) => p.id === selectedId);
                    if (provider) {
                      const currentName = getValues("name")?.trim() ?? "";
                      if (!currentName || providerOptions.some((p) => currentName.startsWith(p.name))) {
                        setValue("name", formatResourceNameWithDate(provider.name));
                      }
                    }
                  },
                })}>
                  <option value="">请选择厂商</option>
                  {providerOptions.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}（{p.code}）
                    </option>
                  ))}
                </select>
                <button data-write-action
                  className="h-10 shrink-0 rounded-lg border border-ql-border bg-ql-surface px-3 text-[13px] font-medium text-ql-action hover:bg-ql-action-soft"
                  onClick={() => setShowNewProvider((v) => !v)}
                  type="button"
                >
                  新建厂商
                </button>
                <button data-write-action
                  className="h-10 shrink-0 rounded-lg border border-ql-border bg-ql-surface px-3 text-[13px] font-medium text-ql-fg-secondary hover:bg-ql-surface-subtle"
                  onClick={() => setShowManageProviders(true)}
                  type="button"
                >
                  管理厂商
                </button>
              </div>
            </FormField>
            {showNewProvider ? (
              <div className="sm:col-span-2 flex items-end gap-2 rounded-lg border border-ql-border-zone bg-ql-surface p-3">
                <FormField htmlFor="new-provider-code" label="厂商代码">
                  <select
                    className={INPUT_CLASS}
                    id="new-provider-code"
                    onChange={(e) => setNewProviderCode(e.target.value)}
                    value={newProviderCode}
                  >
                    <option value="deepseek">deepseek</option>
                    <option value="zhipu">zhipu</option>
                    <option value="kimi">kimi</option>
                  </select>
                </FormField>
                <FormField htmlFor="new-provider-name" label="显示名称">
                  <input
                    className={INPUT_CLASS}
                    id="new-provider-name"
                    onChange={(e) => setNewProviderName(e.target.value)}
                    placeholder="如：智谱"
                    value={newProviderName}
                  />
                </FormField>
                <button
                  className="h-10 shrink-0 rounded-lg bg-ql-action px-4 text-[13px] font-medium text-white hover:bg-ql-action-hover disabled:opacity-60"
                  disabled={createProviderMutation.isPending || !newProviderName}
                  onClick={() =>
                    createProviderMutation.mutate({ code: newProviderCode, name: newProviderName })
                  }
                  type="button"
                >
                  {createProviderMutation.isPending ? "创建中…" : "确认"}
                </button>
                {createProviderMutation.error ? (
                  <p className="text-[12px] text-ql-danger">{createProviderMutation.error.message}</p>
                ) : null}
              </div>
            ) : null}
            <FormField error={errors.name?.message} htmlFor="res-name" label="资源名称">
              <input
                className={INPUT_CLASS}
                id="res-name"
                placeholder="如：智谱-260913 或 智谱 GLM 主账号-260913"
                {...register("name")}
              />
            </FormField>
            <FormField error={errors.mode?.message} htmlFor="res-mode" label="模式">
              <select
                className={INPUT_CLASS}
                id="res-mode"
                {...register("mode", {
                  onChange: (event) => {
                    clearCreateDiscovery();
                    const nextMode = event.target.value as ProviderResourceItem["mode"];
                    const forbidden =
                      nextMode === "API" ? PLAN_OPERATING_KEYS : API_OPERATING_KEYS;
                    for (const key of forbidden) {
                      if (key !== "currency") {
                        setValue(
                          key as keyof CreateResourceValues,
                          key === "reset_cycle" ? "NONE" : "",
                        );
                      }
                    }
                  },
                })}
              >
                <option value="API">API</option>
                <option value="CODING_PLAN">套餐</option>
              </select>
            </FormField>
            <FormField
              error={errors.credential_type?.message}
              htmlFor="res-cred-type"
              label="凭证类型"
            >
              <select
                className={INPUT_CLASS}
                id="res-cred-type"
                {...register("credential_type")}
              >
                <option value="API_KEY">API Key</option>
                <option value="OAUTH">OAuth</option>
                <option value="SUBSCRIPTION_SESSION">订阅会话</option>
              </select>
            </FormField>
            <FormField
              error={errors.credential_plaintext?.message}
              hint="凭证明文仅一次提交，立即加密存储，绝不回显"
              htmlFor="res-cred"
              label="上游凭证"
            >
              <input
                autoComplete="off"
                className={INPUT_CLASS}
                id="res-cred"
                placeholder="sk-..."
                type="password"
                {...register("credential_plaintext", { onChange: clearCreateDiscovery })}
              />
            </FormField>
            <FormField
              error={errors.concurrency_limit?.message}
              hint="按套餐能力填写，例如 5；留空表示不做本地并发限制"
              htmlFor="res-concurrency"
              label="并发上限"
            >
              <input
                className={INPUT_CLASS}
                id="res-concurrency"
                inputMode="numeric"
                {...register("concurrency_limit")}
              />
            </FormField>
            <CreateModelDiscoveryPanel
              discovery={discovery}
              getCredentials={() => {
                const values = getValues();
                return {
                  provider_id: values.provider_id,
                  mode: values.mode,
                  credential_plaintext: values.credential_plaintext,
                };
              }}
              onDiscovery={(result) => {
                setDiscovery(result);
                setSelectedModelIds(result.models.filter((model) => model.compatible).map((model) => model.id));
                setCreateValidationError("");
              }}
              onSelectedModelIdsChange={setSelectedModelIds}
              onValidationError={setCreateValidationError}
              selectedModelIds={selectedModelIds}
            />
            <div className="sm:col-span-2 border-t border-ql-border pt-3">
              <h3 className="text-[13px] font-semibold text-ql-fg">厂商经营快照（可选）</h3>
              <p className="mt-1 text-[12px] text-ql-fg-tertiary">
                未录入字段显示“未录入/未同步”，不会用主体分配额度代替。
              </p>
            </div>
            {createMode === "CODING_PLAN" ? (
              <>
                <FormField error={errors.total_quota?.message} htmlFor="res-total-quota" label="厂商总额度">
                  <IntegerAmountInput
                    aria-invalid={Boolean(errors.total_quota)}
                    id="res-total-quota"
                    name="total_quota"
                    onChange={(value) => setValue("total_quota", value, { shouldDirty: true })}
                    value={createTotalQuota}
                  />
                </FormField>
                <FormField htmlFor="res-quota-unit" label="原生单位">
                  <input className={INPUT_CLASS} id="res-quota-unit" {...register("quota_unit")} />
                </FormField>
                <div className="rounded-lg border border-ql-border bg-ql-surface px-3 py-2 sm:col-span-2">
                  <p className="text-[12px] font-medium text-ql-fg">系统自动计算</p>
                  <p className="mt-1 text-[12px] leading-5 text-ql-fg-tertiary">
                    已用额度取当前周期内该资源的账本扣减；剩余额度和下一次重置日期由系统生成。
                  </p>
                </div>
                <FormField htmlFor="res-package-name" label="套餐名称">
                  <input className={INPUT_CLASS} id="res-package-name" {...register("package_name")} />
                </FormField>
                <div className="rounded-lg border border-ql-border bg-ql-surface px-3 py-2 text-[12px] text-ql-fg-tertiary">订阅金额和服务周期在“充值与订阅”中登记。</div>
              </>
            ) : (
              <div className="rounded-lg border border-ql-border bg-ql-surface px-3 py-2 text-[12px] text-ql-fg-tertiary sm:col-span-2">API 期初、充值、余额和费用统一由“充值与订阅”资金账本管理。</div>
            )}
            {createMode === "CODING_PLAN" ? (
              <>
                <FormField htmlFor="res-reset-cycle" label="重置周期">
                  <select className={INPUT_CLASS} id="res-reset-cycle" {...register("reset_cycle")}>
                    <option value="NONE">不重置</option>
                    <option value="DAILY">每日</option>
                    <option value="WEEKLY">每周</option>
                    <option value="MONTHLY">每月</option>
                    <option value="QUARTERLY">每季</option>
                    <option value="YEARLY">每年</option>
                  </select>
                </FormField>
                {createResetCycle !== "NONE" ? (
                  <FormField error={errors.reset_anchor_at?.message} htmlFor="res-reset-anchor" label="重置日期">
                    <input className={INPUT_CLASS} id="res-reset-anchor" type="datetime-local" {...register("reset_anchor_at")} />
                  </FormField>
                ) : null}
              </>
            ) : null}
          </div>
          {createValidationError ? (
            <p className="text-[13px] leading-5 text-ql-danger" role="alert">{createValidationError}</p>
          ) : createMutation.error ? (
            <p className="text-[13px] leading-5 text-ql-danger" role="alert">
              {createMutation.error.message}
            </p>
          ) : null}
          <div className="flex justify-end gap-2">
            <button data-write-action
              className="h-9 rounded-lg border border-ql-border bg-ql-surface px-4 text-[14px] font-medium text-ql-fg hover:border-ql-border-strong"
              onClick={() => {
                setShowCreate(false);
                reset();
              }}
              type="button"
            >
              取消
            </button>
            <button
              className="h-9 min-w-[5.5rem] rounded-lg bg-ql-action px-4 text-[14px] font-medium text-white hover:bg-ql-action-hover disabled:cursor-not-allowed disabled:opacity-60"
              disabled={createMutation.isPending}
              type="submit"
            >
              {createMutation.isPending ? "接入中…" : "确认接入"}
            </button>
          </div>
        </form>
      ) : null}

      {showManageProviders ? <ProviderManagementDialog model={model} /> : null}
  </>;
}
