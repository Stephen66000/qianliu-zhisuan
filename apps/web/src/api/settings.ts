import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AdminPermissions } from "@qianliu/contracts";
import { get, patch, put, del } from "./client";
export interface CustomRole { name: string; permissions: AdminPermissions; version: number }
export interface SecuritySettings { session_minutes: number; login_max_failures: number; login_lock_minutes: number; force_initial_password_change: boolean; security_version: number }
export function useRole() { return useQuery({ queryKey: ["admin-role"], queryFn: () => get<{ role: CustomRole | null }>("/admin-role") }); }
export function useSaveRole() {
  const client = useQueryClient();
  return useMutation({ mutationFn: (body: { name: string; permissions: AdminPermissions; expected_version: number }) => put("/admin-role", body),
    onSuccess: async () => { await client.invalidateQueries({ queryKey: ["admin-role"] }); await client.invalidateQueries({ queryKey: ["auth"] }); } });
}
export function useSecuritySettings() { return useQuery({ queryKey: ["security-settings"], queryFn: () => get<{ settings: SecuritySettings; password_policy: string }>("/security-settings") }); }
export function useSaveSecurity() {
  const client = useQueryClient();
  return useMutation({ mutationFn: (body: Omit<SecuritySettings, "security_version"> & { expected_version: number }) => patch("/security-settings", body),
    onSuccess: async () => { await client.invalidateQueries({ queryKey: ["security-settings"] }); await client.invalidateQueries({ queryKey: ["admin-sessions"] }); } });
}
export interface SessionItem { id: string; username: string; display_name: string; user_agent: string | null; ip_address: string | null; last_seen_at: string | null; created_at: string; expires_at: string }
export function useSessions() { return useQuery({ queryKey: ["admin-sessions"], queryFn: () => get<{ sessions: SessionItem[]; current_session_id: string }>("/admin-sessions"), refetchInterval: 30_000 }); }
export function useRevokeSession() {
  const client = useQueryClient();
  return useMutation({ mutationFn: (id: string) => del("/admin-sessions/" + id), onSuccess: () => client.invalidateQueries({ queryKey: ["admin-sessions"] }) });
}
export interface AuditItem { id: string; action: string; target_type: string; target_id: string | null; target_name: string | null; actor_source: string; actor_name: string | null; actor_username: string | null; result: string; failure_reason: string | null; change_summary: Record<string, unknown> | null; created_at: string }
export function useAudit(params: URLSearchParams) { return useQuery({ queryKey: ["operation-logs", params.toString()], queryFn: () => get<{ logs: AuditItem[]; total: number; timezone: string; actors: { id: string; username: string; display_name: string }[] }>("/operation-logs?" + params) }); }
export function useVersion() { return useQuery({ queryKey: ["system-version"], queryFn: () => get<{ product: string; version: string | null; releases: { id: string; from_version: string | null; to_version: string | null; status: string; summary: string; started_at: string; finished_at: string | null }[] }>("/system-version") }); }
