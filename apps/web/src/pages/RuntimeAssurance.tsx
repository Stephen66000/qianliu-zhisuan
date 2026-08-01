import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Activity, Bell, History, ShieldCheck, Users } from "lucide-react";
import { useSearchParams } from "react-router-dom";

import { get, patch, post } from "../api/client";
import { useAlerts, usePrincipals } from "../api/hooks";
import { PageShell } from "../components/layout/PageShell";
import { StatusTag } from "../components/dashboard/StatusTag";
import { INPUT_CLASS } from "../components/writes/FormField";

type Tab = "overview" | "rules" | "events" | "alerts" | "notifications";
const TABS: Array<{ key: Tab; label: string }> = [
  { key: "overview", label: "运行态势" },
  { key: "rules", label: "可用性规则" },
  { key: "events", label: "熔断事件" },
  { key: "alerts", label: "异常中心" },
  { key: "notifications", label: "通知与人员" },
];
const RA_KEY = ["runtime-assurance"] as const;

interface Overview {
  resources: Record<string, number>;
  open_event_count: number;
  blocked_resource_count: number;
  affected_request_count: number;
  next_recover_at: string | null;
}
interface RuleVersion {
  id: string; rule_version: number; status: string; version: number;
  unified_signal: string | null; action: "WARN_ONLY" | "BLOCK";
  recovery_method: string | null; fallback_duration_seconds: number | null;
}
interface RuleView {
  rule: { id: string; name: string; rule_type: string; description: string | null };
  current_version: RuleVersion;
  versions?: RuleVersion[];
}
interface AvailabilityEvent {
  id: string; event_number: string; upstream_model: string | null; unified_signal: string;
  availability_decision: string; status: string; started_at: string; recover_at: string | null;
  affected_request_count: number;
}
interface PersonView {
  id: string; name: string; department_label: string | null; status: string; version: number;
  active_project_count: number;
  wecom_identity: { provider_user_id: string } | null;
}
interface EndpointView {
  id: string; corp_id: string; agent_id: string; secret_masked: string;
  secret_fingerprint: string; status: "ACTIVE" | "DISABLED"; version: number;
}
interface Delivery {
  id: string; delivery_type: string; status: string; attempt_count: number;
  provider_error_code: string | null; last_error_classification: string | null; created_at: string;
}

export function RuntimeAssurancePage() {
  const [params, setParams] = useSearchParams();
  const requested = params.get("tab") as Tab | null;
  const tab = TABS.some((item) => item.key === requested) ? requested! : "overview";
  return (
    <PageShell description="资源健康、硬熔断、异常与企微成员定向通知的统一管理入口" title="运行保障">
      <div className="mb-5 flex flex-wrap gap-2 border-b border-ql-border pb-3" role="tablist">
        {TABS.map((item) => (
          <button
            aria-selected={tab === item.key}
            className={`rounded-lg px-3 py-2 text-[13px] font-medium ${tab === item.key ? "bg-ql-action text-white" : "text-ql-fg-secondary hover:bg-ql-surface-subtle"}`}
            key={item.key}
            onClick={() => setParams({ tab: item.key })}
            role="tab"
            type="button"
          >{item.label}</button>
        ))}
      </div>
      {tab === "overview" ? <OverviewPanel /> : null}
      {tab === "rules" ? <RulesPanel /> : null}
      {tab === "events" ? <EventsPanel /> : null}
      {tab === "alerts" ? <AlertsPanel /> : null}
      {tab === "notifications" ? <NotificationsPanel /> : null}
    </PageShell>
  );
}

function OverviewPanel() {
  const query = useQuery({ queryKey: [...RA_KEY, "overview"], queryFn: () => get<Overview>("/runtime-assurance/overview") });
  if (query.isLoading) return <p className="text-sm text-ql-fg-tertiary">正在加载运行态势…</p>;
  if (query.error || !query.data) return <PanelError onRetry={() => void query.refetch()} />;
  const data = query.data;
  const metrics = [
    ["活跃熔断", data.open_event_count], ["受阻资源", data.blocked_resource_count],
    ["影响请求", data.affected_request_count], ["降级资源", data.resources.DEGRADED ?? 0],
  ];
  return <div>
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {metrics.map(([label, value]) => <div className="rounded-xl border border-ql-border bg-ql-surface-subtle p-4" key={label}>
        <p className="text-xs text-ql-fg-tertiary">{label}</p><p className="mt-1 text-2xl font-semibold text-ql-fg">{value}</p>
      </div>)}
    </div>
    <p className="mt-4 text-[13px] text-ql-fg-secondary">下次自动恢复：{data.next_recover_at ? new Date(data.next_recover_at).toLocaleString("zh-CN") : "暂无"}</p>
  </div>;
}

function RulesPanel() {
  const client = useQueryClient();
  const query = useQuery({ queryKey: [...RA_KEY, "rules"], queryFn: () => get<{ rules: RuleView[] }>("/availability-rules?history=true") });
  const [editing, setEditing] = useState<RuleView | null>(null);
  const [name, setName] = useState("");
  const [ruleType, setRuleType] = useState("UPSTREAM_SIGNAL");
  const [signal, setSignal] = useState("QUOTA_EXHAUSTED");
  const [action, setAction] = useState<"WARN_ONLY" | "BLOCK">("BLOCK");
  const [recovery, setRecovery] = useState("FIXED_DURATION");
  const mutation = useMutation({
    mutationFn: async () => {
      const version = {
        unified_signal: ruleType === "SCHEDULE_BLOCK" ? null : signal,
        action, recovery_method: action === "BLOCK" ? recovery : null,
        fallback_duration_seconds: recovery === "FIXED_DURATION" ? 600 : null,
        ...(ruleType === "SCHEDULE_BLOCK" ? {
          schedule_timezone: "Asia/Shanghai", schedule_days_of_week: [1, 2, 3, 4, 5],
          schedule_start_time: "18:00", schedule_end_time: "19:00",
        } : {}),
      };
      return editing
        ? patch(`/availability-rules/${editing.rule.id}`, { name, expected_version: editing.current_version.version, version })
        : post("/availability-rules", { name, rule_type: ruleType, version });
    },
    onSuccess: () => { setEditing(null); setName(""); void client.invalidateQueries({ queryKey: RA_KEY }); },
  });
  const actionMutation = useMutation({
    mutationFn: ({ rule, actionName, source }: { rule: RuleView; actionName: "publish" | "disable" | "rollback"; source?: number }) =>
      post(`/availability-rules/${rule.rule.id}/${actionName}`, {
        expected_version: rule.current_version.version,
        ...(source ? { source_rule_version: source } : {}),
      }),
    onSuccess: () => void client.invalidateQueries({ queryKey: RA_KEY }),
  });
  return <div className="space-y-5">
    <form className="grid gap-3 rounded-xl border border-ql-border bg-ql-surface-subtle p-4 md:grid-cols-7" onSubmit={(event) => { event.preventDefault(); mutation.mutate(); }}>
      <input aria-label="规则名称" className={`${INPUT_CLASS} md:col-span-2`} onChange={(e) => setName(e.target.value)} placeholder="规则名称" required value={name} />
      <select aria-label="规则类型" className={INPUT_CLASS} disabled={Boolean(editing)} onChange={(e) => setRuleType(e.target.value)} value={ruleType}>
        <option value="UPSTREAM_SIGNAL">上游信号</option><option value="SCHEDULE_BLOCK">计划熔断</option><option value="OBSERVATION_ALERT">观察预警</option>
      </select>
      <select aria-label="统一信号" className={INPUT_CLASS} onChange={(e) => setSignal(e.target.value)} value={signal}>
        <option value="QUOTA_EXHAUSTED">额度耗尽</option><option value="PLAN_EXPIRED">套餐过期</option><option value="MODEL_UNAUTHORIZED">模型未授权</option><option value="TECHNICAL_FAILURE">技术故障</option>
      </select>
      <select aria-label="动作" className={INPUT_CLASS} onChange={(e) => setAction(e.target.value as typeof action)} value={action}>
        <option value="BLOCK">硬熔断</option><option value="WARN_ONLY">仅预警</option>
      </select>
      <select aria-label="恢复方式" className={INPUT_CLASS} disabled={action === "WARN_ONLY"} onChange={(e) => setRecovery(e.target.value)} value={recovery}>
        <option value="FIXED_DURATION">固定 10 分钟</option><option value="RETRY_AFTER">Retry-After</option><option value="UPSTREAM_RESET_TIME">上游重置时间</option><option value="MANUAL">人工恢复</option>
      </select>
      <button className="rounded-lg bg-ql-action px-3 text-sm font-medium text-white disabled:opacity-50" disabled={mutation.isPending} type="submit">{editing ? "保存为新版本" : "新建草稿"}</button>
      {editing ? <button className="text-sm text-ql-fg-secondary" onClick={() => { setEditing(null); setName(""); }} type="button">取消编辑</button> : null}
    </form>
    {query.error ? <PanelError onRetry={() => void query.refetch()} /> : null}
    <div className="space-y-3">
      {(query.data?.rules ?? []).map((item) => <div className="rounded-xl border border-ql-border p-4" key={item.rule.id}>
        <div className="flex flex-wrap items-center gap-2"><strong className="text-sm text-ql-fg">{item.rule.name}</strong><StatusTag tone={item.current_version.status === "PUBLISHED" ? "success" : "neutral"}>{item.current_version.status}</StatusTag><span className="text-xs text-ql-fg-tertiary">v{item.current_version.rule_version} · {item.rule.rule_type}</span></div>
        <div className="mt-3 flex flex-wrap gap-2">
          <SmallButton onClick={() => { setEditing(item); setName(item.rule.name); setRuleType(item.rule.rule_type); setSignal(item.current_version.unified_signal ?? "TECHNICAL_FAILURE"); setAction(item.current_version.action); }}>编辑新版本</SmallButton>
          {item.current_version.status === "DRAFT" ? <SmallButton onClick={() => actionMutation.mutate({ rule: item, actionName: "publish" })}>发布</SmallButton> : <SmallButton onClick={() => actionMutation.mutate({ rule: item, actionName: "disable" })}>停用</SmallButton>}
          {(item.versions?.length ?? 0) > 1 ? <SmallButton onClick={() => actionMutation.mutate({ rule: item, actionName: "rollback", source: item.versions?.at(-1)?.rule_version })}>回滚最早版本</SmallButton> : null}
          <span className="inline-flex items-center gap-1 text-xs text-ql-fg-tertiary"><History className="h-3.5 w-3.5" />历史 {item.versions?.length ?? 1} 版</span>
        </div>
      </div>)}
    </div>
  </div>;
}

function EventsPanel() {
  const client = useQueryClient();
  const [history, setHistory] = useState(false);
  const query = useQuery({ queryKey: [...RA_KEY, "events", history], queryFn: () => get<{ events: AvailabilityEvent[] }>(`/availability-events?history=${history}`) });
  const recover = useMutation({ mutationFn: (id: string) => post(`/availability-events/${id}/recover`, { reason: "管理员从运行保障页面人工恢复" }), onSuccess: () => void client.invalidateQueries({ queryKey: RA_KEY }) });
  return <div>
    <label className="mb-4 flex items-center gap-2 text-sm text-ql-fg-secondary"><input checked={history} onChange={(e) => setHistory(e.target.checked)} type="checkbox" />显示历史事件</label>
    {query.error ? <PanelError onRetry={() => void query.refetch()} /> : null}
    <div className="space-y-3">{(query.data?.events ?? []).map((event) => <div className="flex flex-wrap items-center gap-3 rounded-xl border border-ql-border p-4" key={event.id}>
      <Activity className="h-5 w-5 text-ql-warning" /><div className="min-w-56 flex-1"><p className="text-sm font-medium text-ql-fg">{event.event_number} · {event.upstream_model ?? "全模型"}</p><p className="text-xs text-ql-fg-tertiary">{event.unified_signal} · 影响请求 {event.affected_request_count} · {new Date(event.started_at).toLocaleString("zh-CN")}</p></div><StatusTag tone={event.status === "OPEN" ? "danger" : "neutral"}>{event.status}</StatusTag>{event.status === "OPEN" ? <SmallButton onClick={() => recover.mutate(event.id)}>人工恢复</SmallButton> : null}
    </div>)}</div>
    {!query.isLoading && (query.data?.events.length ?? 0) === 0 ? <Empty icon={<ShieldCheck />} text="当前没有熔断事件" /> : null}
  </div>;
}

function AlertsPanel() {
  const client = useQueryClient();
  const query = useAlerts(true);
  const visible = [...(query.data?.alerts ?? []), ...(query.data?.history ?? [])];
  const disposition = useMutation({
    mutationFn: (alertKey: string) => post("/alerts/disposition", { alert_key: alertKey, status: "RESOLVED" }),
    onSuccess: () => void client.invalidateQueries({ queryKey: ["alerts"] }),
  });
  if (query.error) return <PanelError onRetry={() => void query.refetch()} />;
  return <div className="space-y-3">{visible.map((alert) => <div className="rounded-xl border border-ql-border p-4" key={alert.id}><div className="flex flex-wrap items-center gap-2"><Bell className="h-4 w-4 text-ql-warning" /><strong className="text-sm text-ql-fg">{alert.title}</strong><StatusTag tone={alert.status === "OPEN" ? "warning" : "neutral"}>{alert.status}</StatusTag>{alert.status === "OPEN" || alert.status === "INVESTIGATING" ? <SmallButton onClick={() => disposition.mutate(alert.alertKey)}>标记已处理</SmallButton> : null}</div><p className="mt-1 text-xs text-ql-fg-secondary">{alert.detail}</p></div>)}{!query.isLoading && visible.length === 0 ? <Empty icon={<ShieldCheck />} text="当前没有异常" /> : null}</div>;
}

function NotificationsPanel() {
  const client = useQueryClient();
  const endpointQuery = useQuery({ queryKey: [...RA_KEY, "endpoint"], queryFn: () => get<{ endpoint: EndpointView | null }>("/notification-endpoints/wecom-app") });
  const peopleQuery = useQuery({ queryKey: [...RA_KEY, "people"], queryFn: () => get<{ people: PersonView[] }>("/people") });
  const deliveryQuery = useQuery({ queryKey: [...RA_KEY, "deliveries"], queryFn: () => get<{ deliveries: Delivery[] }>("/notification-deliveries?limit=30") });
  const principalsQuery = usePrincipals("exclude");
  const [corpId, setCorpId] = useState(""); const [agentId, setAgentId] = useState(""); const [secret, setSecret] = useState("");
  const [personName, setPersonName] = useState(""); const [department, setDepartment] = useState("");
  const [selectedPerson, setSelectedPerson] = useState(""); const [selectedPrincipal, setSelectedPrincipal] = useState(""); const [userid, setUserid] = useState("");
  const refresh = () => void client.invalidateQueries({ queryKey: RA_KEY });
  const endpointMutation = useMutation({ mutationFn: () => patch("/notification-endpoints/wecom-app", { corp_id: corpId || endpointQuery.data?.endpoint?.corp_id, agent_id: agentId || endpointQuery.data?.endpoint?.agent_id, secret: secret || undefined, status: "ACTIVE", expected_version: endpointQuery.data?.endpoint?.version }), onSuccess: () => { setSecret(""); refresh(); } });
  const personMutation = useMutation({ mutationFn: () => post("/people", { name: personName, department_label: department || null }), onSuccess: () => { setPersonName(""); setDepartment(""); refresh(); } });
  const identityMutation = useMutation({ mutationFn: () => { const person = (peopleQuery.data?.people ?? []).find((item) => item.id === selectedPerson); if (!person) throw new Error("请选择人员"); return patch(`/people/${person.id}/wecom-identity`, { provider_user_id: userid, expected_version: person.version }); }, onSuccess: refresh });
  const bindMutation = useMutation({ mutationFn: () => { const principal = (principalsQuery.data?.principals ?? []).find((item) => item.id === selectedPrincipal) as { id: string; type: "EMPLOYEE" | "PROJECT"; version?: number } | undefined; if (!principal) throw new Error("请选择主体"); return patch(`/principals/${principal.id}/${principal.type === "EMPLOYEE" ? "person" : "owner"}`, { person_id: selectedPerson, expected_version: principal.version ?? 1 }); }, onSuccess: refresh });
  const testMutation = useMutation({ mutationFn: () => post("/notification-endpoints/wecom-app/test", { person_id: selectedPerson }), onSuccess: refresh });
  const people = peopleQuery.data?.people ?? [];
  return <div className="space-y-6">
    <section><h2 className="mb-3 text-sm font-semibold text-ql-fg">企业微信自建应用</h2><form className="grid gap-3 md:grid-cols-4" onSubmit={(e) => { e.preventDefault(); endpointMutation.mutate(); }}><input aria-label="CorpID" className={INPUT_CLASS} onChange={(e) => setCorpId(e.target.value)} placeholder={endpointQuery.data?.endpoint?.corp_id ?? "CorpID"} value={corpId} /><input aria-label="AgentID" className={INPUT_CLASS} onChange={(e) => setAgentId(e.target.value)} placeholder={endpointQuery.data?.endpoint?.agent_id ?? "AgentID"} value={agentId} /><input aria-label="Secret" className={INPUT_CLASS} onChange={(e) => setSecret(e.target.value)} placeholder={endpointQuery.data?.endpoint ? "留空表示不轮换 Secret" : "应用 Secret"} type="password" value={secret} /><button className="rounded-lg bg-ql-action px-3 text-sm font-medium text-white" type="submit">保存应用配置</button></form>{endpointQuery.data?.endpoint ? <p className="mt-2 text-xs text-ql-fg-tertiary">Secret {endpointQuery.data.endpoint.secret_masked} · 指纹 {endpointQuery.data.endpoint.secret_fingerprint} · {endpointQuery.data.endpoint.status}</p> : null}</section>
    <section><h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-ql-fg"><Users className="h-4 w-4" />人员与接收关系</h2><form className="mb-3 grid gap-3 md:grid-cols-3" onSubmit={(e) => { e.preventDefault(); personMutation.mutate(); }}><input aria-label="人员姓名" className={INPUT_CLASS} onChange={(e) => setPersonName(e.target.value)} placeholder="人员姓名" required value={personName} /><input aria-label="部门" className={INPUT_CLASS} onChange={(e) => setDepartment(e.target.value)} placeholder="部门/标签" value={department} /><button className="rounded-lg border border-ql-border text-sm font-medium text-ql-fg" type="submit">新增人员</button></form><div className="grid gap-3 md:grid-cols-4"><select aria-label="选择人员" className={INPUT_CLASS} onChange={(e) => setSelectedPerson(e.target.value)} value={selectedPerson}><option value="">选择人员</option>{people.map((person) => <option key={person.id} value={person.id}>{person.name}{person.wecom_identity ? ` · ${person.wecom_identity.provider_user_id}` : " · 未配 userid"}</option>)}</select><input aria-label="企微 userid" className={INPUT_CLASS} onChange={(e) => setUserid(e.target.value)} placeholder="企微内部成员 userid" value={userid} /><button className="rounded-lg border border-ql-border text-sm text-ql-fg" disabled={!selectedPerson || !userid} onClick={() => identityMutation.mutate()} type="button">绑定 userid</button><button className="rounded-lg border border-ql-border text-sm text-ql-fg" disabled={!selectedPerson} onClick={() => testMutation.mutate()} type="button">测试发送给本人</button><select aria-label="选择主体" className={INPUT_CLASS} onChange={(e) => setSelectedPrincipal(e.target.value)} value={selectedPrincipal}><option value="">选择员工/项目主体</option>{(principalsQuery.data?.principals ?? []).map((principal) => <option key={principal.id} value={principal.id}>{principal.name} · {principal.type === "EMPLOYEE" ? "本人" : "负责人"}</option>)}</select><button className="rounded-lg border border-ql-border text-sm text-ql-fg" disabled={!selectedPerson || !selectedPrincipal} onClick={() => bindMutation.mutate()} type="button">绑定人员关系</button></div></section>
    <section><h2 className="mb-3 text-sm font-semibold text-ql-fg">最近发送记录</h2><div className="space-y-2">{(deliveryQuery.data?.deliveries ?? []).map((delivery) => <div className="flex items-center gap-3 rounded-lg bg-ql-surface-subtle px-3 py-2 text-xs" key={delivery.id}><span>{delivery.delivery_type}</span><StatusTag tone={delivery.status === "SENT" ? "success" : delivery.status.includes("FAILED") ? "danger" : "neutral"}>{delivery.status}</StatusTag><span className="text-ql-fg-tertiary">尝试 {delivery.attempt_count} 次 · {delivery.provider_error_code ?? delivery.last_error_classification ?? "无错误"}</span></div>)}</div></section>
  </div>;
}

function SmallButton({ children, onClick }: { children: React.ReactNode; onClick: () => void }) { return <button className="rounded-md border border-ql-border px-2.5 py-1 text-xs text-ql-fg hover:bg-ql-surface-subtle" onClick={onClick} type="button">{children}</button>; }
function PanelError({ onRetry }: { onRetry: () => void }) { return <div className="rounded-lg bg-ql-danger-soft p-3 text-sm text-ql-danger">加载失败。<button className="ml-2 underline" onClick={onRetry} type="button">重试</button></div>; }
function Empty({ icon, text }: { icon: React.ReactNode; text: string }) { return <div className="flex flex-col items-center gap-2 py-10 text-sm text-ql-fg-tertiary">{icon}{text}</div>; }
