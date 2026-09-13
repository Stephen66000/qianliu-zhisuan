import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { get, post, put } from "./client";

export type NotificationCategory =
  | "SYSTEM_FAILURE"
  | "UPSTREAM_RESOURCE"
  | "FINANCE_SECURITY"
  | "PERSONNEL_ACCOUNT";

export interface PersonWecomIdentity {
  id: string;
  person_id: string;
  provider: "WECOM";
  provider_user_id: string;
  status: "ACTIVE" | "DISABLED";
  verified_at?: string | null;
}

export interface PersonItem {
  id: string;
  name: string;
  department_label: string | null;
  status: "ACTIVE" | "DISABLED";
  version: number;
  wecom_identity: PersonWecomIdentity | null;
  active_project_count: number;
}

export type NotificationRecipientsMap = Record<NotificationCategory, PersonItem[]>;

export const NOTIFICATION_CATEGORY_META: Record<
  NotificationCategory,
  {
    title: string;
    description: string;
    badge: string;
    examples: string;
    badgeColor: string;
  }
> = {
  SYSTEM_FAILURE: {
    title: "系统级故障",
    description: "API 网关崩溃、服务完全不可用、基础设施瘫痪",
    badge: "P0 致命级",
    examples: "网关 502/504、数据库连接池耗尽、核心服务宕机",
    badgeColor: "bg-red-50 text-red-700 border-red-200",
  },
  UPSTREAM_RESOURCE: {
    title: "上游资源故障",
    description: "厂商凭证失效/被封、全线熔断无备用资源、连续调用高频报错",
    badge: "P1 严重级",
    examples: "Key 失效被拒(401/403)、厂商模型全池不可用、连续错误率超阈值",
    badgeColor: "bg-amber-50 text-amber-700 border-amber-200",
  },
  FINANCE_SECURITY: {
    title: "资金与财务异常",
    description: "上游厂商欠费停机、每日对账严重偏差、调用突增/盗刷攻击",
    badge: "P1/P2 财务级",
    examples: "厂商欠费停机(402)、账本对账严重差异、10分钟内调用量暴增10倍",
    badgeColor: "bg-purple-50 text-purple-700 border-purple-200",
  },
  PERSONNEL_ACCOUNT: {
    title: "人员、账号与安全",
    description: "员工离职自动注销 Key、员工账号被系统风控锁定/冻结",
    badge: "P3 安全审计",
    examples: "离职人员凭证已吊销确认、账号异地异常调用锁定",
    badgeColor: "bg-blue-50 text-blue-700 border-blue-200",
  },
};

export const NOTIFICATION_KEYS = {
  all: ["runtime-assurance", "notifications"] as const,
  recipients: () => [...NOTIFICATION_KEYS.all, "recipients"] as const,
  people: () => ["runtime-assurance", "people"] as const,
};

export function useNotificationRecipients() {
  return useQuery({
    queryKey: NOTIFICATION_KEYS.recipients(),
    queryFn: async () => {
      const data = await get<{ recipients: NotificationRecipientsMap }>(
        "/runtime-assurance/notification-recipients",
      );
      return data.recipients;
    },
  });
}

export function usePeopleList() {
  return useQuery({
    queryKey: NOTIFICATION_KEYS.people(),
    queryFn: async () => {
      const data = await get<{ people: PersonItem[] }>("/people");
      return data.people;
    },
  });
}

export function useSaveNotificationRecipients() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (recipients: Record<NotificationCategory, string[]>) => {
      return put<{ recipients: NotificationRecipientsMap }>(
        "/runtime-assurance/notification-recipients",
        { recipients },
      );
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: NOTIFICATION_KEYS.recipients(),
      });
    },
  });
}

export function useTestNotification() {
  return useMutation({
    mutationFn: async (personId: string) => {
      return post<{ delivery: unknown }>(
        "/runtime-assurance/notification-recipients/test",
        { person_id: personId },
      );
    },
  });
}
