import { useAccess } from "../permissions";
import type { AdminModule } from "@qianliu/contracts";
export function useCatalogPath(kind: "providers" | "resources" | "models" | "principals", full: string) {
  const owner: AdminModule = kind === "principals" ? "principals" : "resources";
  return useAccess().can(owner) ? full : "/reference-data/" + kind;
}
