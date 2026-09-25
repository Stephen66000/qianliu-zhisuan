import type { Kysely } from "kysely";
import {
  isEnterpriseQuiescent,
  type Database,
  type OperatingBillRepository,
  type OperatingBillView,
} from "@qianliu/database";

/**
 * POOL-025 月账聚合任务。
 *
 * 数据库仓储负责固定时区、费用口径和版本语义；Worker 只触发同一套确定性聚合，
 * 避免定时任务与 Control API 各写一套算法。
 *
 * **不导出**：这是未设防的纯委托实现。任何生产入口都必须经过
 * `generateOperatingBillGuarded` 的静默门禁（PFA-09），不导出可杜绝第二入口。
 */
async function generateOperatingBill(
  repository: Pick<OperatingBillRepository, "getBill">,
  enterpriseId: string,
  month: string,
): Promise<OperatingBillView> {
  return repository.getBill(enterpriseId, month);
}

/**
 * PFA-09 静默门禁包装：目标企业处于**有效**静默租约内时整企业跳过月账聚合。
 *
 * 为什么要跳过：激活预检会把"涉及月份的经营账单是否完整"作为候选事实参与投影，
 * 静默期内继续生成或关闭月账会让已冻结的候选漂移。跳过不是失败——
 * 租约到期或被解除后下一个 tick 自动恢复，无需人工干预或补偿。
 */
export async function generateOperatingBillGuarded(input: {
  db: Kysely<Database>;
  repository: Pick<OperatingBillRepository, "getBill">;
  enterpriseId: string;
  month: string;
  now?: Date;
}): Promise<{ status: "GENERATED"; bill: OperatingBillView } | { status: "SKIPPED_QUIESCENT" }> {
  if (await isEnterpriseQuiescent(input.db, input.enterpriseId, input.now ?? new Date())) {
    return { status: "SKIPPED_QUIESCENT" };
  }
  return {
    status: "GENERATED",
    bill: await generateOperatingBill(input.repository, input.enterpriseId, input.month),
  };
}

/**
 * 月账命令行任务的唯一实现（`worker operating-bill --enterprise <id> --month <YYYY-MM>`）。
 *
 * 门禁内聚：命令入口只调用本函数，本函数**只**调用 `generateOperatingBillGuarded`，
 * 因此不存在绕过静默门禁的月账写入路径。`SKIPPED_QUIESCENT` 以结构化事件输出，
 * 与 `GENERATED` 区分，便于运维与证据归档判定。
 */
export async function runOperatingBillTask(input: {
  db: Kysely<Database>;
  repository: Pick<OperatingBillRepository, "getBill">;
  enterpriseId: string;
  month: string;
  now?: Date;
  log?: (line: string) => void;
}): Promise<"GENERATED" | "SKIPPED_QUIESCENT"> {
  const log = input.log ?? ((line: string): void => { process.stdout.write(`${line}\n`); });
  const outcome = await generateOperatingBillGuarded(input);
  if (outcome.status === "SKIPPED_QUIESCENT") {
    log(JSON.stringify({
      event: "operating_bill_skipped_quiescent",
      enterprise_id: input.enterpriseId, month: input.month, reason: "enterprise_quiescent",
    }));
    return "SKIPPED_QUIESCENT";
  }
  const bill = outcome.bill;
  log(JSON.stringify({
    event: "operating_bill_generated", enterprise_id: input.enterpriseId, month: input.month,
    status: bill.status, version: bill.version, total_cost: bill.summary.totalCost,
    gap_count: bill.gaps.length, generated_at: bill.generatedAt,
  }));
  return "GENERATED";
}
