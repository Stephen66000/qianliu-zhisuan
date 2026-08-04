import { useMutation, useQueryClient } from "@tanstack/react-query";

import { patch } from "../../api/client";
import { QUERY_KEYS, usePrincipalAgentUsage } from "../../api/hooks";
import { formatCount, formatDateTimeFull, formatMoney } from "../../lib/format";

const EXPECTED_AGENT_OPTIONS = [
  ["WORKBUDDY", "WorkBuddy"], ["CODEX", "Codex"], ["ZCODE", "Z Code"],
  ["CLAUDE_CODE", "Claude Code"], ["QIANLIU_IDE", "仟流 IDE"],
] as const;

export function AgentUsagePanel({ principalId }: { principalId: string }) {
  const queryClient = useQueryClient();
  const query = usePrincipalAgentUsage(principalId);
  const updateExpectedAgents = useMutation({
    mutationFn: (agentFamilies: string[]) => patch(`/principals/${principalId}/agent-expectations`, {
      agent_families: agentFamilies,
    }),
    onSuccess: () => queryClient.invalidateQueries({
      queryKey: QUERY_KEYS.principalAgentUsage(principalId),
    }),
  });

  return <div className="mt-4 rounded-lg border border-ql-border-zone bg-ql-surface p-4">
    <h3 className="text-[13px] font-semibold text-ql-fg">Agent 使用情况</h3>
    <p className="mt-1 text-[11px] text-ql-fg-tertiary">来自真实请求观测，仅用于统计诊断，不参与鉴权、额度、计费或调度。</p>
    <fieldset className="mt-3 flex flex-wrap gap-3 rounded-md border border-ql-border-zone p-2">
      <legend className="px-1 text-[11px] text-ql-fg-secondary">预期 Agent（交付元数据，可多选）</legend>
      {EXPECTED_AGENT_OPTIONS.map(([value, label]) => {
        const selected = query.data?.expectedAgentFamilies.includes(value) ?? false;
        return <label className="flex items-center gap-1 text-[12px]" key={value}>
          <input checked={selected} disabled={updateExpectedAgents.isPending} onChange={() => {
            const current = query.data?.expectedAgentFamilies ?? [];
            updateExpectedAgents.mutate(selected
              ? current.filter((item) => item !== value)
              : [...current, value]);
          }} type="checkbox" />{label}
        </label>;
      })}
    </fieldset>
    {query.isLoading
      ? <p className="mt-3 text-[12px] text-ql-fg-tertiary">正在读取…</p>
      : (query.data?.agents.length ?? 0) === 0
        ? <p className="mt-3 text-[12px] text-ql-fg-tertiary">尚未观察到 Agent 请求</p>
        : <div className="mt-3 overflow-x-auto">
          <table className="w-full text-left text-[12px]">
            <thead className="text-ql-fg-secondary"><tr><th className="p-2">Agent / 版本</th><th className="p-2">识别来源</th><th className="p-2 text-right">请求</th><th className="p-2 text-right">Token</th><th className="p-2 text-right">API 费用</th><th className="p-2">最近使用</th><th className="p-2">模型</th></tr></thead>
            <tbody>{query.data?.agents.map((agent) => <tr className="border-t border-ql-border-zone" key={agent.agentFamily}>
              <td className="p-2 font-medium">{agent.agentFamily}<span className="block font-normal text-ql-fg-tertiary">{agent.latestVersion ? `v${agent.latestVersion}` : "版本未知"}</span>{(query.data?.expectedAgentFamilies.length ?? 0) > 0 && !query.data?.expectedAgentFamilies.includes(agent.agentFamily) ? <span className="block text-[11px] font-normal text-ql-warning">与预期不一致</span> : null}</td>
              <td className="p-2 text-ql-fg-secondary">{agent.identitySource} · {agent.identityConfidence}</td>
              <td className="p-2 text-right">{formatCount(agent.requestCount)}</td>
              <td className="p-2 text-right">{formatCount(agent.totalTokens)}</td>
              <td className="p-2 text-right">{formatMoney(agent.totalApiCost)}</td>
              <td className="p-2">{formatDateTimeFull(agent.lastUsedAt)}</td>
              <td className="p-2">{agent.models.join("、")}</td>
            </tr>)}</tbody>
          </table>
        </div>}
  </div>;
}
