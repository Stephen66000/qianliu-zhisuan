import type { OperatingBillRepository, OperatingBillView } from "@qianliu/database";

/**
 * POOL-025 月账聚合任务。
 *
 * 数据库仓储负责固定时区、费用口径和版本语义；Worker 只触发同一套确定性聚合，
 * 避免定时任务与 Control API 各写一套算法。
 */
export async function generateOperatingBill(
  repository: Pick<OperatingBillRepository, "getBill">,
  enterpriseId: string,
  month: string,
): Promise<OperatingBillView> {
  return repository.getBill(enterpriseId, month);
}
