import { useEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { KeyRound, Settings2 } from "lucide-react";

import { post } from "../../api/client";
import { QUERY_KEYS, useAccessConfiguration, useGrants, usePrincipalKeys, useUnifiedModels } from "../../api/hooks";
import type { AccessConfiguration, Principal, PrincipalGrantItem } from "../../api/types";
import { useOrganizationUnits, useProjectDepartmentAssignment, useSaveProjectDepartmentAssignment } from "../../api/v2-hooks";
import { StatusTag } from "../dashboard/StatusTag";
import { ConfirmDialog } from "../writes/ConfirmDialog";
import { INPUT_CLASS } from "../writes/FormField";
import { formatCount } from "../../lib/format";
import { useFeatureFlags } from "../../feature-flags";
import { AgentUsagePanel } from "./AgentUsagePanel";
import { PrincipalAccessConfigPanel } from "./PrincipalAccessConfigPanel";
import { PrincipalKeyDialog } from "./PrincipalKeyDialog";

function shouldRevealKey(mounted: boolean, currentId: string, requestedId: string): boolean {
  return mounted && currentId === requestedId;
}

function configuredAliases(accessConfig: AccessConfiguration | undefined): string[] | null {
  if (!accessConfig) return null;
  return accessConfig.providers.flatMap((provider) =>
    provider.models.filter((model) => model.enabled).map((model) => model.alias)
  );
}

function resolveGatewayBaseUrl(): string {
  return (import.meta.env.VITE_GATEWAY_BASE_URL as string | undefined) ??
    (import.meta.env.PROD ? "https://gw.qianliuai.com/v1" : "http://127.0.0.1:8787/v1");
}

export function PrincipalAccessPanel({ principal }: { principal: Principal }) {
  const featureFlags = useFeatureFlags();
  const queryClient = useQueryClient();
  const keysQuery = usePrincipalKeys(principal.id);
  const grantsQuery = useGrants(principal.id);
  const modelsQuery = useUnifiedModels();
  const [plaintextKey, setPlaintextKey] = useState<string | null>(null);
  const [keyDialogOpen, setKeyDialogOpen] = useState(false);
  const [copyStatus, setCopyStatus] = useState<"idle" | "success" | "error">("idle");
  const [resetConfirm, setResetConfirm] = useState(false);
  const [archiveGrantTarget, setArchiveGrantTarget] = useState<PrincipalGrantItem | null>(null);
  // POOL-033（GLM 评审 P0-1）：池化后额度只读展示——调额/超额/停用统一走上方
  // 接入配置面板（编排端点单事务），不再提供 PATCH /grants/:id 直写入口。
  const currentPrincipalIdRef = useRef(principal.id);
  const mountedRef = useRef(true);
  currentPrincipalIdRef.current = principal.id;

  useEffect(() => {
    setPlaintextKey(null);
    setKeyDialogOpen(false);
    setCopyStatus("idle");
    setResetConfirm(false);
    setArchiveGrantTarget(null);
  }, [principal.id]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const refreshKeys = (principalId = principal.id) =>
    queryClient.invalidateQueries({ queryKey: QUERY_KEYS.principalKeys(principalId) });

  const createKey = useMutation({
    mutationFn: async () => {
      const requestedPrincipalId = principal.id;
      const result = await post<{ key: string }>(`/principals/${requestedPrincipalId}/key`, {
        allowed_model_ids: [],
      });
      return { requestedPrincipalId, key: result.key };
    },
    onSuccess: (result) => {
      void refreshKeys(result.requestedPrincipalId);
      void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.dashboard });
      if (shouldRevealKey(
        mountedRef.current, currentPrincipalIdRef.current, result.requestedPrincipalId,
      )) {
        setPlaintextKey(result.key);
        setKeyDialogOpen(true);
        setCopyStatus("idle");
      }
    },
  });

  const resetKey = useMutation({
    mutationFn: async () => {
      const requestedPrincipalId = principal.id;
      const result = await post<{ key: string }>(
        `/principals/${requestedPrincipalId}/key/reset`,
      );
      return { requestedPrincipalId, key: result.key };
    },
    onSuccess: (result) => {
      void refreshKeys(result.requestedPrincipalId);
      void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.dashboard });
      if (shouldRevealKey(
        mountedRef.current, currentPrincipalIdRef.current, result.requestedPrincipalId,
      )) {
        setPlaintextKey(result.key);
        setKeyDialogOpen(true);
        setCopyStatus("idle");
        setResetConfirm(false);
      }
    },
  });

  const archiveGrant = useMutation({
    mutationFn: (grant: PrincipalGrantItem) =>
      post<{ grant: PrincipalGrantItem }>(`/grants/${grant.id}/archive`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.grants(principal.id) });
      void queryClient.invalidateQueries({
        queryKey: QUERY_KEYS.accessConfiguration(principal.id),
      });
      setArchiveGrantTarget(null);
    },
  });

  const activeKey = (keysQuery.data?.keys ?? []).find((key) => key.status === "ACTIVE");
  const models = (modelsQuery.data?.models ?? []).filter((model) => model.status === "ACTIVE");
  const grants = grantsQuery.data?.grants ?? [];
  const gatewayBaseUrl = resolveGatewayBaseUrl();
  const allowedModelIds = activeKey?.allowed_model_ids ?? [];
  // POOL-033：授权型号以接入配置为准（池化后 allowed_model_ids 由编排端点维护）。
  const accessConfigQuery = useAccessConfiguration(principal.id);
  const accessConfig = accessConfigQuery.data;
  const authorizedAliases = configuredAliases(accessConfig) ?? models
    .filter((model) => allowedModelIds.includes(model.id))
    .filter((model) =>
      grants.some((grant) =>
        grant.status === "ACTIVE"
        && grant.model_alias === model.alias
        && (!grant.valid_until || new Date(grant.valid_until).getTime() > Date.now())
      )
    )
    .map((model) => model.alias);
  const copyConnectionInfo = async () => {
    if (!plaintextKey) return;
    const content = [
      `Gateway Base URL: ${gatewayBaseUrl}`,
      `API Key: ${plaintextKey}`,
      `Models: ${authorizedAliases.join(", ") || "暂无已授权且有效额度的模型"}`,
      "Protocol: OpenAI-compatible (/v1/chat/completions, /v1/responses)",
    ].join("\n");
    try {
      await navigator.clipboard.writeText(content);
      setCopyStatus("success");
    } catch {
      setCopyStatus("error");
    }
  };

  return (
    <section className="mt-5 rounded-xl border border-ql-border bg-ql-surface-subtle p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-[14px] font-semibold text-ql-fg">
            <Settings2 aria-hidden className="h-4 w-4" />
            {principal.name} · 接入配置
          </h2>
          <p className="mt-1 text-[12px] text-ql-fg-tertiary">
            生成 Key → 按厂商配置额度与型号 → 保存生效 → 复制接入信息。
          </p>
        </div>
      </div>

      {featureFlags.FEATURE_DEPARTMENT_COST && principal.type === "PROJECT" ? (
        <ProjectDepartmentEditor projectId={principal.id} />
      ) : null}

      <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-2">
        <div className="rounded-lg border border-ql-border-zone bg-ql-surface p-4">
          <h3 className="text-[13px] font-semibold text-ql-fg">主体 Key</h3>
          {keysQuery.isLoading ? (
            <p className="mt-2 text-[13px] text-ql-fg-tertiary">正在读取 Key 元数据…</p>
          ) : activeKey ? (
            <div className="mt-2">
              <div className="flex flex-wrap items-center gap-2">
                <code className="rounded bg-ql-surface-muted px-2 py-1 text-[12px]">
                  {activeKey.key_prefix}••••••••
                </code>
                <StatusTag tone="neutral">有效</StatusTag>
                <button
                  className="rounded-md px-2 py-1 text-[12px] font-medium text-ql-warning hover:bg-ql-warning-soft"
                  onClick={() => setResetConfirm(true)}
                  type="button"
                >
                  重置 Key
                </button>
              </div>
            </div>
          ) : null}

          {activeKey ? null : (
            <button
              className="mt-3 flex h-9 items-center gap-1.5 rounded-lg bg-ql-action px-3 text-[13px] font-medium text-white disabled:opacity-60"
              disabled={createKey.isPending || principal.status !== "ACTIVE"}
              onClick={() => createKey.mutate()}
              type="button"
            >
              <KeyRound aria-hidden className="h-4 w-4" />
              生成 Key
            </button>
          )}
          {createKey.error || resetKey.error ? (
            <p className="mt-2 text-[12px] text-ql-danger" role="alert">
              {(createKey.error ?? resetKey.error)?.message}
            </p>
          ) : null}

          <div className="mt-4 border-t border-ql-border-zone pt-3">
            <h3 className="text-[13px] font-semibold text-ql-fg">接入信息</h3>
            <dl className="mt-2 grid grid-cols-[5rem_1fr] gap-1 text-[12px]">
              <dt className="text-ql-fg-tertiary">Base URL</dt>
              <dd className="break-all font-mono text-ql-fg">{gatewayBaseUrl}</dd>
              <dt className="text-ql-fg-tertiary">API Key</dt>
              <dd className="font-mono text-ql-fg">
                {plaintextKey
                  ? plaintextKey
                  : activeKey
                    ? `${activeKey.key_prefix}••••••••`
                    : "生成后一次展示"}
              </dd>
              <dt className="text-ql-fg-tertiary">模型</dt>
              <dd className="text-ql-fg">
                {authorizedAliases.join("、") ||
                  "尚未分配"}
              </dd>
            </dl>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <button
                className="h-8 rounded-md bg-ql-action px-3 text-[12px] font-medium text-white disabled:cursor-not-allowed disabled:opacity-50"
                disabled={!plaintextKey}
                onClick={() => void copyConnectionInfo()}
                type="button"
              >
                复制接入信息
              </button>
              {plaintextKey ? (
                <button
                  className="h-8 rounded-md border border-ql-border px-3 text-[12px] text-ql-fg-secondary"
                  onClick={() => {
                    setPlaintextKey(null);
                    setCopyStatus("idle");
                  }}
                  type="button"
                >
                  清除一次性 Key
                </button>
              ) : (
                <span className="text-[11px] text-ql-warning">
                  完整 Key 已不可恢复；如未保存，请重置 Key。
                </span>
              )}
              {copyStatus === "success" ? (
                <span className="text-[11px] text-ql-success" role="status">复制成功</span>
              ) : null}
              {copyStatus === "error" ? (
                <span className="text-[11px] text-ql-danger" role="alert">复制失败，请检查剪贴板权限</span>
              ) : null}
            </div>
          </div>
        </div>

        <div className="rounded-lg border border-ql-border-zone bg-ql-surface p-4">
          <h3 className="text-[13px] font-semibold text-ql-fg">型号与额度</h3>
          <p className="mt-1 text-[12px] text-ql-fg-tertiary">
            按厂商开通额度池；厂商下型号默认全开，可单个掐掉。
          </p>
          <div className="mt-3">
            <PrincipalAccessConfigPanel principalId={principal.id} />
          </div>
        </div>
      </div>

      {grants.length > 0 ? (
        <div className="mt-4 overflow-x-auto rounded-lg border border-ql-border-zone bg-ql-surface">
          <table className="w-full border-collapse text-left text-[12px]">
            <thead>
              <tr className="border-b border-ql-border text-ql-fg-tertiary">
                <th className="p-2 font-medium">模型</th>
                <th className="p-2 font-medium">厂商</th>
                <th className="p-2 text-right font-medium">额度</th>
                <th className="p-2 font-medium">超额</th>
                <th className="p-2 font-medium">状态</th>
              </tr>
            </thead>
            <tbody>
              {grants.map((grant) => (
                <tr className="border-b border-ql-border-zone last:border-b-0" key={grant.id}>
                  <td className="p-2 font-medium">
                    {grant.model_alias === "*" ? (
                      <SharedQuotaModels accessConfig={accessConfig} provider={grant.provider} />
                    ) : grant.model_alias}
                  </td>
                  <td className="p-2 text-ql-fg-secondary">{grant.provider}</td>
                  <td className="p-2 text-right font-mono">{formatCount(grant.quota_value)}</td>
                  <td className="p-2">{grant.allow_overage ? "允许" : "不允许"}</td>
                  <td className="p-2">
                    {grant.status === "ACTIVE" ? "有效" : grant.status === "DISABLED" ? (
                      <div className="flex items-center gap-2">
                        <span>已停用</span>
                        <button
                          className="rounded px-2 py-1 text-[11px] text-ql-action hover:bg-ql-action-soft"
                          onClick={() => setArchiveGrantTarget(grant)}
                          type="button"
                        >归档</button>
                      </div>
                    ) : "已过期"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="border-t border-ql-border-zone p-2 text-[12px] text-ql-fg-tertiary">
            额度为只读展示；调额、超额开关与停用请在上方「接入配置」面板中操作。
          </p>
        </div>
      ) : null}

      <AgentUsagePanel principalId={principal.id} />

      <ConfirmDialog
        confirmLabel="确认归档"
        impact={`归档后，这条 ${archiveGrantTarget?.provider ?? "厂商"} 授权将退出日常授权列表；额度、请求、账本、审计和历史关联继续保留。`}
        loading={archiveGrant.isPending}
        onCancel={() => setArchiveGrantTarget(null)}
        onConfirm={() => archiveGrantTarget && archiveGrant.mutate(archiveGrantTarget)}
        open={archiveGrantTarget !== null}
        title="归档已停用授权"
      />

      <ConfirmDialog
        danger
        confirmLabel="确认重置"
        impact={`重置后「${principal.name}」的旧 Key 将立即撤销；新 Key 完整继承模型、IP、有效期和限额，新 Key 明文只展示一次。`}
        loading={resetKey.isPending}
        onCancel={() => setResetConfirm(false)}
        onConfirm={() => resetKey.mutate()}
        open={resetConfirm}
        title="重置主体 Key"
      />
      <PrincipalKeyDialog
        copyStatus={copyStatus}
        onClose={() => setKeyDialogOpen(false)}
        onCopy={() => void copyConnectionInfo()}
        open={keyDialogOpen}
        plaintextKey={plaintextKey}
      />
    </section>
  );
}

function SharedQuotaModels({
  accessConfig,
  provider,
}: {
  accessConfig: AccessConfiguration | undefined;
  provider: string;
}) {
  const models = accessConfig?.providers
    .find((item) => item.provider_code === provider)
    ?.models.filter((model) => model.enabled)
    .map((model) => model.display_name) ?? [];
  return <div>
    <span>该厂商共享额度</span>
    <span className="block max-w-[28rem] font-normal text-ql-fg-tertiary">
      已授权 {models.length} 个型号：{models.join("、") || "暂无有效型号"}
    </span>
  </div>;
}

function ProjectDepartmentEditor({ projectId }: { projectId: string }) {
  const projectDepartment = useProjectDepartmentAssignment(projectId);
  const organizationUnits = useOrganizationUnits();
  const save = useSaveProjectDepartmentAssignment(projectId);
  const [departmentId, setDepartmentId] = useState("");
  useEffect(() => {
    setDepartmentId(projectDepartment.data?.assignment?.organization_unit_id ?? "");
  }, [projectDepartment.data?.assignment?.organization_unit_id]);
  return <div className="mt-4 rounded-lg border border-ql-border-zone bg-ql-surface p-4">
    <h3 className="text-[13px] font-semibold text-ql-fg">项目归属部门</h3>
    <p className="mt-1 text-[11px] text-ql-fg-tertiary">仅影响设置后的新请求；历史请求按发生时点快照保留。</p>
    <div className="mt-3 flex flex-wrap items-center gap-2">
      <select aria-label="项目归属部门" className={`${INPUT_CLASS} min-w-56`} disabled={organizationUnits.isLoading} onChange={(event) => setDepartmentId(event.target.value)} value={departmentId}>
        <option value="">请选择部门</option>
        {(organizationUnits.data?.units ?? []).map((unit) => <option key={unit.id} value={unit.id}>{unit.path}</option>)}
      </select>
      <button className="h-9 rounded-lg bg-ql-action px-3 text-[12px] font-medium text-white disabled:opacity-50" disabled={!departmentId || save.isPending} onClick={() => void save.mutateAsync({
        organization_unit_id: departmentId,
        expected_version: projectDepartment.data?.assignment?.version ?? 0,
        reason: "WEB_ADMIN",
      })} type="button">{save.isPending ? "保存中…" : "保存归属"}</button>
      {projectDepartment.data?.assignment ? <span className="text-[11px] text-ql-fg-tertiary">版本 {projectDepartment.data.assignment.version} · {projectDepartment.data.assignment.department_name}</span> : null}
    </div>
    {projectDepartment.error || save.error ? <p className="mt-2 text-[12px] text-ql-danger">{(projectDepartment.error ?? save.error)?.message}</p> : null}
  </div>;
}
