import type { Kysely } from "kysely";
import {
  loadDepartmentBill as loadDatabaseDepartmentBill,
  type Database,
  type DepartmentBillView,
} from "@qianliu/database";

/** 草稿月读实时数据，已结账月只读结账版本中的部门冻结证据。 */
export function loadDepartmentBillView(
  db: Kysely<Database>,
  enterpriseId: string,
  month: string,
  financeEnabled = false,
): Promise<DepartmentBillView> {
  return loadDatabaseDepartmentBill(db, enterpriseId, month, financeEnabled);
}

export { loadDepartmentBillView as loadDepartmentBill };
