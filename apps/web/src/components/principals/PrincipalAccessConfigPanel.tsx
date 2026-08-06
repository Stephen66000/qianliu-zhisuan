/** POOL-033：接入配置面板 —— 厂商池额度 + 型号准入开关。
 *
 * 产品语义（2026-08-05 与需求方当面对齐）：
 * - 管理员按厂商给员工一个总额度池（如 Kimi 5000 万、DeepSeek 3 亿）；
 * - 厂商下所有就绪型号默认全开，可单个掐掉（掐型号不影响池）；
 * - 主体总额度 = 各厂商池之和，自动汇总；
 * - 新接入型号自动并入已开通厂商（池存续期间默认放行）。
 *
 * 页面结构：厂商块（池额度 + 型号表）→ 底部汇总 → 保存并生效。
 */
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronRight } from "lucide-react";

import { put } from "../../api/client";
import { QUERY_KEYS, useAccessConfiguration } from "../../api/hooks";
import type {
  AccessConfigPoolInput,
  AccessConfigPutBody,
  AccessConfigPutResult,
  AccessConfiguration,
} from "../../api/types";

/** 千分位格式化（展示层；内部状态仍是纯数字字符串）。 */
function formatThousands(value: string): string {
  const digits = value.replace(/\D/g, "");
  if (digits === "") return "";
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function parseQuota(value: string): string {
  return value.replace(/\D/g, "");
}

interface ProviderDraft {
  provider_code: string;
  /** 是否开通该厂商（有池额度且至少勾选一个型号）。 */
  enabled: boolean;
  quota_value: string; // 展示用千分位
  allow_overage: boolean;
  valid_until: string | null;
  /** 勾选的型号 id 集合。 */
  enabled_model_ids: Set<string>;
}

function draftFromConfig(config: AccessConfiguration): Map<string, ProviderDraft> {
  const map = new Map<string, ProviderDraft>();
  for (const provider of config.providers) {
    const enabledModelIds = new Set(
      provider.models.filter((m) => m.ready && m.enabled).map((m) => m.unified_model_id),
    );
    map.set(provider.provider_code, {
      provider_code: provider.provider_code,
      enabled: provider.pool !== null,
      quota_value: provider.pool ? formatThousands(provider.pool.quota_value) : "",
      allow_overage: provider.pool?.allow_overage ?? false,
      valid_until: provider.pool?.valid_until ?? null,
      enabled_model_ids: enabledModelIds,
    });
  }
  return map;
}

export function PrincipalAccessConfigPanel({ principalId }: { principalId: string }) {
  const queryClient = useQueryClient();
  const configQuery = useAccessConfiguration(principalId);
  const [drafts, setDrafts] = useState<Map<string, ProviderDraft>>(new Map());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState(false);

  const config = configQuery.data;

  useEffect(() => {
    if (config) {
      setDrafts(draftFromConfig(config));
      // 默认全部折叠，管理员点击厂商标题展开配置。
      setExpanded(new Set());
    }
  }, [config]);

  const saveMutation = useMutation({
    mutationFn: async (body: AccessConfigPutBody) =>
      put<AccessConfigPutResult>(`/principals/${principalId}/access-configuration`, body),
    onSuccess: () => {
      setSaveSuccess(true);
      setSaveError(null);
      // POOL-033：保存会原子改写该主体的授权规则、Grant、额度计数器与 Key 白名单，
      // 因此除本面板外，还需连带刷新下方 Grant 只读表、首页超额名单与主体列表额度状态，
      // 避免管理员切页后看到陈旧的额度/超额/Grant 数据。
      // invalidateQueries 按前缀匹配：["principals"] 会连带刷新所有 principal 子查询。
      void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.principals });
      void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.grants(principalId) });
      void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.dashboard });
      setTimeout(() => setSaveSuccess(false), 3000);
    },
    onError: (error) => {
      setSaveSuccess(false);
      setSaveError(error instanceof Error ? error.message : "保存失败，请重试");
    },
  });

  const summary = useMemo(() => {
    let totalQuota = 0n;
    let providerCount = 0;
    let modelCount = 0;
    for (const draft of drafts.values()) {
      if (!draft.enabled) continue;
      const quota = parseQuota(draft.quota_value);
      if (quota !== "" && quota !== "0") {
        totalQuota += BigInt(quota);
        providerCount += 1;
        modelCount += draft.enabled_model_ids.size;
      }
    }
    return { totalQuota, providerCount, modelCount };
  }, [drafts]);

  if (configQuery.isLoading) return <p className="text-muted">加载接入配置…</p>;
  if (configQuery.isError) return <p className="text-destructive">加载失败：{configQuery.error.message}</p>;
  if (!config) return null;

  const updateDraft = (providerCode: string, patch: Partial<ProviderDraft>) => {
    setDrafts((prev) => {
      const next = new Map(prev);
      const current = next.get(providerCode);
      if (!current) return prev;
      next.set(providerCode, { ...current, ...patch });
      return next;
    });
  };

  const toggleProvider = (providerCode: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(providerCode)) next.delete(providerCode);
      else next.add(providerCode);
      return next;
    });
  };

  const handleSave = () => {
    const providers: AccessConfigPoolInput[] = [...drafts.values()]
      .filter((d) => d.enabled)
      .map((d) => ({
        provider_code: d.provider_code,
        quota_value: parseQuota(d.quota_value) || "0",
        allow_overage: d.allow_overage,
        valid_until: d.valid_until,
        enabled_model_ids: [...d.enabled_model_ids],
      }));
    saveMutation.mutate({
      expected_version: config.config_version,
      idempotency_key: crypto.randomUUID(),
      providers,
    });
  };

  return (
    <section aria-label="接入配置" className="space-y-4">
      {config.manual_pending_takeover.length > 0 && (
        <div className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/10 p-3 text-sm">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
          <div>
            <p className="font-medium">历史手工授权待接管</p>
            <p className="text-muted-foreground">
              该员工存在 {config.manual_pending_takeover.length} 个历史手工授权型号。保存本页配置后将自动接管，
              期间权限不会中断。
            </p>
          </div>
        </div>
      )}

      <div className="space-y-3">
        {config.providers.map((provider) => {
          const draft = drafts.get(provider.provider_code);
          if (!draft) return null;
          const isExpanded = expanded.has(provider.provider_code);
          const readyModels = provider.models.filter((m) => m.ready);
          const notReadyModels = provider.models.filter((m) => !m.ready);

          return (
            <div key={provider.provider_code} className="rounded-lg border">
              <button
                type="button"
                className="flex w-full items-center justify-between p-3 text-left"
                onClick={() => toggleProvider(provider.provider_code)}
              >
                <div className="flex items-center gap-2">
                  {isExpanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                  <span className="font-medium">{provider.provider_name}</span>
                  {provider.pool && (
                    <span className="text-sm text-muted-foreground">
                      已用 {formatThousands(provider.pool.quota_used)} / {formatThousands(provider.pool.quota_value)}
                    </span>
                  )}
                </div>
                <label className="flex items-center gap-2 text-sm" onClick={(e) => e.stopPropagation()}>
                  <input
                    type="checkbox"
                    checked={draft.enabled}
                    onChange={(e) => {
                      const enabled = e.target.checked;
                      updateDraft(provider.provider_code, {
                        enabled,
                        // 开通时默认全选就绪型号。
                        enabled_model_ids: enabled
                          ? new Set(readyModels.map((m) => m.unified_model_id))
                          : new Set(),
                      });
                      // 勾"开通"时自动展开该厂商，让额度输入和型号勾选立即可见。
                      if (enabled) {
                        setExpanded((prev) => new Set([...prev, provider.provider_code]));
                      }
                    }}
                  />
                  开通
                </label>
              </button>

              {isExpanded && draft.enabled && (
                <div className="border-t p-3 space-y-3">
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                    <label className="block text-sm">
                      <span className="mb-1 block text-muted-foreground">Token 额度</span>
                      <input
                        type="text"
                        inputMode="numeric"
                        className="w-full rounded-md border px-3 py-2"
                        value={draft.quota_value}
                        onChange={(e) => updateDraft(provider.provider_code, { quota_value: formatThousands(e.target.value) })}
                        placeholder="如 50,000,000"
                      />
                    </label>
                    <label className="flex items-end gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={draft.allow_overage}
                        onChange={(e) => updateDraft(provider.provider_code, { allow_overage: e.target.checked })}
                      />
                      允许超额
                    </label>
                    <label className="block text-sm">
                      <span className="mb-1 block text-muted-foreground">有效期（可选）</span>
                      <input
                        type="datetime-local"
                        className="w-full rounded-md border px-3 py-2"
                        value={draft.valid_until ?? ""}
                        onChange={(e) => updateDraft(provider.provider_code, { valid_until: e.target.value || null })}
                      />
                    </label>
                  </div>

                  <div>
                    <p className="mb-2 text-sm text-muted-foreground">
                      型号（默认全开，可单个掐掉）
                    </p>
                    <div className="space-y-1">
                      {readyModels.map((model) => (
                        <label key={model.unified_model_id} className="flex items-center gap-2 text-sm">
                          <input
                            type="checkbox"
                            checked={draft.enabled_model_ids.has(model.unified_model_id)}
                            onChange={(e) => {
                              const next = new Set(draft.enabled_model_ids);
                              if (e.target.checked) next.add(model.unified_model_id);
                              else next.delete(model.unified_model_id);
                              updateDraft(provider.provider_code, { enabled_model_ids: next });
                            }}
                          />
                          <span>{model.display_name}</span>
                          <span className="text-muted-foreground">({model.alias})</span>
                        </label>
                      ))}
                      {notReadyModels.map((model) => (
                        <div key={model.unified_model_id} className="flex items-center gap-2 text-sm text-muted-foreground">
                          <input type="checkbox" disabled />
                          <span>{model.display_name}</span>
                          <span className="text-muted-foreground">({model.alias})</span>
                          <span className="text-xs">未就绪：{model.unavailable_reasons.join("；")}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="flex items-center justify-between rounded-lg border bg-muted/50 p-4">
        <div>
          <p className="font-medium">
            已开通 {summary.providerCount} 个厂商，共 {summary.modelCount} 个型号
          </p>
          <p className="text-sm text-muted-foreground">
            总额度 {summary.totalQuota.toLocaleString()} Token（各厂商池之和）
          </p>
        </div>
        <div className="flex items-center gap-3">
          {saveSuccess && (
            <span className="flex items-center gap-1 text-sm text-green-600">
              <CheckCircle2 className="h-4 w-4" /> 已保存
            </span>
          )}
          {saveError && <span className="text-sm text-destructive">{saveError}</span>}
          <button
            type="button"
            className="rounded-md border border-primary/30 bg-primary/10 px-5 py-2.5 text-sm font-semibold text-primary transition-colors hover:bg-primary/20 disabled:cursor-not-allowed disabled:border-primary/20 disabled:bg-primary/5 disabled:opacity-50"
            onClick={handleSave}
            disabled={saveMutation.isPending || summary.providerCount === 0}
          >
            {saveMutation.isPending ? "保存中…" : "保存并生效"}
          </button>
        </div>
      </div>
    </section>
  );
}
