import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { get, patch, post } from "./client";
import type {
  EmployeeModelRuleValidation,
  EmployeeModelRuleVersion,
  EmployeeModelTarget,
  EmployeeRuleCatalog,
} from "./types";

export const EMPLOYEE_RULES_KEY = ["employee-model-rules"] as const;
export const EMPLOYEE_RULE_CATALOG_KEY = ["employee-model-rules", "catalog"] as const;

export interface EmployeeModelRulePayload {
  name: string;
  employee_scope: "SELECTED" | "ALL";
  principal_ids: string[];
  model_scope: "SELECTED" | "ALL";
  model_targets: EmployeeModelTarget[];
  quota_value: string;
  allow_overage: boolean;
  valid_from: string;
  valid_until: string | null;
}

export function useEmployeeRuleCatalog() {
  return useQuery({
    queryKey: EMPLOYEE_RULE_CATALOG_KEY,
    queryFn: ({ signal }) => get<EmployeeRuleCatalog>("/employee-model-rules/catalog", signal),
    staleTime: 15_000,
  });
}

export function useEmployeeModelRules() {
  return useQuery({
    queryKey: EMPLOYEE_RULES_KEY,
    queryFn: ({ signal }) => get<{ rules: EmployeeModelRuleVersion[] }>("/employee-model-rules", signal),
    staleTime: 10_000,
  });
}

function mutation<T>(fn: (input: T) => Promise<unknown>) {
  return () => {
    const queryClient = useQueryClient();
    return useMutation({
      mutationFn: fn,
      onSuccess: () => Promise.all([
        queryClient.invalidateQueries({ queryKey: EMPLOYEE_RULES_KEY }),
        queryClient.invalidateQueries({ queryKey: EMPLOYEE_RULE_CATALOG_KEY }),
      ]),
    });
  };
}

export const useCreateEmployeeModelRule = mutation((rule: EmployeeModelRulePayload) =>
  post<{ version: EmployeeModelRuleVersion }>("/employee-model-rules", rule));

export const useUpdateEmployeeModelRule = mutation((input: {
  versionId: string;
  expectedLockVersion: number;
  rule: EmployeeModelRulePayload;
}) => patch(`/employee-model-rules/versions/${input.versionId}`, {
  expected_lock_version: input.expectedLockVersion,
  rule: input.rule,
}));

export const useValidateEmployeeModelRule = mutation((versionId: string) =>
  post<{ validation: EmployeeModelRuleValidation }>(`/employee-model-rules/versions/${versionId}/validate`));

export const usePublishEmployeeModelRule = mutation((input: {
  versionId: string;
  expectedLockVersion: number;
  idempotencyKey: string;
}) => post(`/employee-model-rules/versions/${input.versionId}/publish`, {
  expected_lock_version: input.expectedLockVersion,
  idempotency_key: input.idempotencyKey,
}));

export const useDisableEmployeeModelRule = mutation((versionId: string) =>
  post(`/employee-model-rules/versions/${versionId}/disable`));

export const useCreateEmployeeModelRuleVersion = mutation((ruleId: string) =>
  post(`/employee-model-rules/${ruleId}/versions`));
