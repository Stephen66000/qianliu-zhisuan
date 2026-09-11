import { z } from "zod";
import type { Principal } from "../api/types";

export const CreatePrincipalSchema = z.object({
  type: z.enum(["EMPLOYEE", "PROJECT"]),
  name: z.string().min(1, "名称不能为空").max(255),
  department_label: z.string().max(255).optional(),
  /** B 方式：点选企微候选人后绑定的自然人 ID；手工输入时为空。 */
  person_id: z.string().uuid().nullable().optional(),
});

export type CreatePrincipalValues = z.infer<typeof CreatePrincipalSchema>;
export type PrincipalTab = "principals" | "directory" | "batch-authorization";

export const TYPE_LABEL: Record<Principal["type"], string> = {
  EMPLOYEE: "员工",
  PROJECT: "项目",
};

export function resolvePrincipalTab(
  requested: string | null,
  directoryEnabled: boolean,
): PrincipalTab {
  if (requested === "batch-authorization") return requested;
  return requested === "directory" && directoryEnabled ? requested : "principals";
}
