import type { Generated } from "kysely";
export interface AdminRoleTable {
  enterprise_id: string;
  name: string;
  permissions: Record<string, { view: boolean; operate: boolean }>;
  version: Generated<number>;
  updated_at: Generated<Date>;
}
