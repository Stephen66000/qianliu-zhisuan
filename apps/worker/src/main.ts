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
import { createKysely, ReconciliationRepository, RuntimeAssuranceRepository } from "@qianliu/database";
import { WecomAppClient } from "./runtime-assurance/wecom-client.js";
import { runRuntimeAssuranceTick } from "./runtime-assurance/runner.js";
import { runSchedulerLoop, startHealthServer, type SchedulerHealth } from "./runtime-assurance/scheduler.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];

  if (command === "reconciliation") {
    await runReconciliationTask(args.slice(1));
    return;
  }

  if (command === "runtime-assurance-once") {
    await runRuntimeAssuranceOnce();
    return;
  }

  if (command === "runtime-assurance-scheduler") {
    await runRuntimeAssuranceScheduler();
    return;
  }

  if (command === "runtime-assurance-migrate-legacy") {
    await migrateLegacyUnavailable();
    return;
  }

  console.log("[worker] 用法：worker reconciliation --enterprise <id> [--from <iso>] [--to <iso>]");
  console.log("[worker]       worker runtime-assurance-once");
  console.log("[worker]       worker runtime-assurance-scheduler");
  console.log("[worker]       worker runtime-assurance-migrate-legacy");
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

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function wecomNotifyEnabled(): boolean {
  const value = process.env.RUNTIME_ASSURANCE_WECOM_NOTIFY ?? "false";
  if (value !== "true" && value !== "false") {
    throw new Error("RUNTIME_ASSURANCE_WECOM_NOTIFY must be true or false");
  }
  return value === "true";
}

async function runRuntimeAssuranceOnce(): Promise<void> {
  const db = createKysely();
  try {
    const result = await runRuntimeAssuranceTick({
      repository: new RuntimeAssuranceRepository(db),
      wecom: new WecomAppClient(requiredEnv("CREDENTIAL_KEK"), fetch, Date.now, process.env.RUNTIME_ASSURANCE_ADMIN_URL),
      wecomNotify: wecomNotifyEnabled(),
    });
    console.log(`[worker] 运行保障扫描完成：recovered=${result.recoveredDue + result.recoveredSchedules} deliveries=${result.deliveriesProcessed} legacy_review=${result.legacyShadowReview}`);
  } finally {
    await db.destroy();
  }
}

async function runRuntimeAssuranceScheduler(): Promise<void> {
  const db = createKysely();
  const controller = new AbortController();
  const health: SchedulerHealth = {
    startedAt: new Date().toISOString(), lastTickAt: null, lastSuccessAt: null,
    lastErrorAt: null, lastErrorCode: null, running: false,
  };
  const port = Number(process.env.WORKER_HEALTH_PORT ?? "9191");
  const intervalMs = Number(process.env.RUNTIME_ASSURANCE_INTERVAL_MS ?? "30000");
  if (!Number.isInteger(port) || port <= 0 || !Number.isFinite(intervalMs) || intervalMs < 1_000) {
    throw new Error("Worker scheduler configuration is invalid");
  }
  const healthServer = startHealthServer(port, health);
  const stop = () => controller.abort();
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  const repository = new RuntimeAssuranceRepository(db);
  const wecom = new WecomAppClient(
    requiredEnv("CREDENTIAL_KEK"), fetch, Date.now, process.env.RUNTIME_ASSURANCE_ADMIN_URL,
  );
  try {
    await runSchedulerLoop({
      db, intervalMs, signal: controller.signal, health,
      tick: () => runRuntimeAssuranceTick({ repository, wecom, wecomNotify: wecomNotifyEnabled() }),
    });
  } finally {
    await new Promise<void>((resolve) => healthServer.close(() => resolve()));
    await db.destroy();
  }
}

async function migrateLegacyUnavailable(): Promise<void> {
  const db = createKysely();
  try {
    const repository = new RuntimeAssuranceRepository(db);
    const assessment = await repository.assessLegacyUnavailable();
    const migrated = await repository.migrateSafeLegacyUnavailable();
    const review = assessment.filter((item) => item.disposition === "MANUAL_REVIEW");
    console.log(`[worker] 六态迁移完成：safe_migrated=${migrated.length} manual_review=${review.length}`);
    if (review.length > 0) console.warn("[worker] 存在需人工复核的旧 UNAVAILABLE 资源，未修改。");
  } finally {
    await db.destroy();
  }
}

main().catch((err) => {
  console.error("[worker] 启动失败:", err);
  process.exit(1);
});
