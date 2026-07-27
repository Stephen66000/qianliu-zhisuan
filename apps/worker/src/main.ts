/**
 * @qianliu/worker —— 对账、预测、恢复、备份任务入口。
 *
 * W17：实现对账任务执行器（runReconciliation）。
 *   - 命令行：worker reconciliation --enterprise <id> [--from <iso> --to <iso>]
 *   - 扫描账本表 → 判定重复 0/丢失<0.1% → 落 reconciliation_run + discrepancies（异常队列）
 *   - 定时调度（每日）在 W25 worker scheduler 落地；当前支持手动触发
 *
 * 预测快照、周期重置、恢复任务、备份在后续工作包（W25）。
 */
import { createKysely, ReconciliationRepository } from "@qianliu/database";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];

  if (command === "reconciliation") {
    await runReconciliationTask(args.slice(1));
    return;
  }

  console.log("[worker] 用法：worker reconciliation --enterprise <id> [--from <iso>] [--to <iso>]");
  console.log("[worker] 其他任务（预测快照/周期重置/恢复/备份）在 W25 落地");
}

function arg(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name);
  return idx >= 0 ? args[idx + 1] : undefined;
}

async function runReconciliationTask(args: string[]): Promise<void> {
  const enterpriseId = arg(args, "--enterprise");
  if (!enterpriseId) {
    console.error("[worker] 缺少 --enterprise 参数");
    process.exit(1);
  }
  // 默认范围：最近 24 小时
  const rangeTo = arg(args, "--to") ? new Date(arg(args, "--to")!) : new Date();
  const rangeFrom = arg(args, "--from") ? new Date(arg(args, "--from")!) : new Date(rangeTo.getTime() - 24 * 3600_000);

  const db = createKysely();
  const repo = new ReconciliationRepository(db);
  try {
    console.log(`[worker] 对账开始：enterprise=${enterpriseId} range=${rangeFrom.toISOString()} ~ ${rangeTo.toISOString()}`);
    const outcome = await repo.runReconciliation({ enterpriseId, rangeFrom, rangeTo });
    const v = outcome.verdict;
    console.log(`[worker] 对账完成：result=${v.result} duplicate=${v.duplicateCount}(rate=${v.duplicateRate}) missing=${v.missingCount}(rate=${v.missingRate}) mismatch=${v.mismatchCount} total=${v.totalDiscrepancies}`);
    if (v.result === "FAIL") {
      console.error(`[worker] 对账失败：重复率>0 或丢失率≥0.1%（TRD 行 870-871）。runId=${outcome.runId}`);
      process.exit(2);
    }
    if (v.result === "REVIEW") {
      console.warn(`[worker] 对账需复核：存在汇总不一致（SETTLEMENT_MISMATCH）。runId=${outcome.runId}`);
    }
  } finally {
    await db.destroy();
  }
}

main().catch((err) => {
  console.error("[worker] 启动失败:", err);
  process.exit(1);
});
