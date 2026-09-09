import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { del, get, patch, post } from "./client";
import type { AdminAccount } from "./types";
import { AUTH_QUERY_KEY } from "./auth";

export const ADMINS_QUERY_KEY = ["admins"] as const;

export function useAdmins(archived = false) {
  return useQuery({
    queryKey: [...ADMINS_QUERY_KEY, archived],
    queryFn: ({ signal }) => get<{ admins: AdminAccount[] }>("/admins" + (archived ? "?archived=true" : ""), signal),
  });
}

function useAdminMutation<TInput>(
  mutationFn: (input: TInput) => Promise<unknown>,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ADMINS_QUERY_KEY }),
  });
}

export function useCreateAdmin() {
  return useAdminMutation(
    (input: { username: string; display_name: string; password: string; role_code?: "SUPER_ADMIN" | "CUSTOM" }) =>
      post("/admins", input),
  );
}

export function useRenameAdmin() {
  return useAdminMutation((input: { id: string; display_name: string; role_code?: "SUPER_ADMIN" | "CUSTOM"; expected_version?: number }) =>
    patch(`/admins/${input.id}`, { display_name: input.display_name, role_code: input.role_code, expected_version: input.expected_version }),
  );
}

export function useResetAdminPassword() {
  return useAdminMutation((input: { id: string; new_password: string }) =>
    post(`/admins/${input.id}/reset-password`, {
      new_password: input.new_password,
    }),
  );
}

export function useSetAdminStatus() {
  return useAdminMutation(
    (input: { id: string; status: "ACTIVE" | "DISABLED" }) =>
      post(
        `/admins/${input.id}/${input.status === "ACTIVE" ? "enable" : "disable"}`,
      ),
  );
}

export function useCleanupAdmin() {
  return useAdminMutation((input: { id: string }) =>
    del<void>(`/admins/${input.id}`),
  );
}

export function useChangeOwnPassword() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { current_password: string; new_password: string }) =>
      post<void>("/auth/change-password", input),
    onSuccess: () => queryClient.removeQueries({ queryKey: AUTH_QUERY_KEY }),
  });
}
