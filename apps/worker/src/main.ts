import { runSubscriptionRenewalTick } from "./subscription-renewal/runner.js";
import { runInfrastructureChecks } from "./runtime-assurance/infrastructure-checks.js";
import { createTaskObserver } from "./runtime-assurance/observed-task.js";
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
import { createKysely, OperatingBillRepository, ReconciliationRepository, RuntimeAssuranceRepository, SupplyForecastRepository, UsageAggregateRepository } from "@qianliu/database";
import { readFeatureFlags } from "@qianliu/config";
import { generateOperatingBill } from "./operating-bill/runner.js";
import { WecomAppClient } from "./runtime-assurance/wecom-client.js";
import { runRuntimeAssuranceTick } from "./runtime-assurance/runner.js";
import { runSchedulerLoop, startHealthServer, type SchedulerHealth } from "./runtime-assurance/scheduler.js";
import { runScheduledOperationalTasks } from "./runtime-assurance/scheduled-tasks.js";
import { runSupplyForecastTick } from "./supply-forecast/runner.js";
import { runCodingPlanQuotaTick } from "./coding-plan-quota/runner.js";
import { runDirectorySyncTick } from "./directory/runner.js";
import { runProviderOperatingSyncTick } from "./provider-operating-sync/runner.js";
import { runUsageAggregateTick } from "./usage-aggregate/runner.js";

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

  if (command === "operating-bill") {
    await runOperatingBillTask(args.slice(1));
    return;
  }

  if (command === "supply-forecast-once") {
    await runSupplyForecastOnce();
    return;
  }

  if (command === "provider-operating-sync-once") {
    await runProviderOperatingSyncOnce();
    return;
  }

  if (command === "directory-sync-once") {
    await runDirectorySyncOnce(args.slice(1));
    return;
  }

  if (command === "usage-aggregate-rebuild") {
    await runUsageAggregateRebuild(args.slice(1));
    return;
  }

  console.log("[worker] 用法：worker reconciliation --enterprise <id> [--from <iso>] [--to <iso>]");
  console.log("[worker]       worker runtime-assurance-once");
  console.log("[worker]       worker runtime-assurance-scheduler");
  console.log("[worker]       worker runtime-assurance-migrate-legacy");
  console.log("[worker]       worker operating-bill --enterprise <id> --month <YYYY-MM>");
  console.log("[worker]       worker supply-forecast-once");
  console.log("[worker]       worker provider-operating-sync-once");
  console.log("[worker]       worker directory-sync-once [--run <run-id>] [--max-runs <1-100>]");
  console.log("[worker]       worker usage-aggregate-rebuild --enterprise <id> --from <iso> --to <iso>");
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
    const outcome = await createTaskObserver(db, enterpriseId)("reconciliation", "对账任务", () => repo.runReconciliation({ enterpriseId, rangeFrom, rangeTo }));
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

async function runOperatingBillTask(args: string[]): Promise<void> {
  const enterpriseId = arg(args, "--enterprise");
  const month = arg(args, "--month");
  if (!enterpriseId || !month) {
    throw new Error("operating-bill 需要 --enterprise 与 --month");
  }
  const db = createKysely();
  try {
    const bill = await generateOperatingBill(new OperatingBillRepository(db), enterpriseId, month);
    console.log(JSON.stringify({
      event: "operating_bill_generated", enterprise_id: enterpriseId, month,
      status: bill.status, version: bill.version, total_cost: bill.summary.totalCost,
      gap_count: bill.gaps.length, generated_at: bill.generatedAt,
    }));
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
  const observe = createTaskObserver(db);
  const controller = new AbortController();
  const health: SchedulerHealth = {
    startedAt: new Date().toISOString(), lastTickAt: null, lastSuccessAt: null,
    lastErrorAt: null, lastErrorCode: null, running: false,
  };
  const port = Number(process.env.WORKER_HEALTH_PORT ?? "9191");
  const intervalMs = Number(process.env.RUNTIME_ASSURANCE_INTERVAL_MS ?? "30000");
  const aggregateDirtyLimit = Number(process.env.USAGE_AGGREGATE_DIRTY_LIMIT ?? "200");
  if (!Number.isInteger(port) || port <= 0 || !Number.isFinite(intervalMs) || intervalMs < 1_000) {
    throw new Error("Worker scheduler configuration is invalid");
  }
  if (!Number.isInteger(aggregateDirtyLimit) || aggregateDirtyLimit < 1 || aggregateDirtyLimit > 1_000) {
    throw new Error("USAGE_AGGREGATE_DIRTY_LIMIT must be an integer between 1 and 1000");
  }
  const healthServer = startHealthServer(port, health);
  const stop = () => controller.abort();
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  const repository = new RuntimeAssuranceRepository(db);
  const supplyForecastRepository = new SupplyForecastRepository(db);
  const usageAggregateRepository = new UsageAggregateRepository(db);
  let lastDailyAggregateDate: string | null = null;
  const wecom = new WecomAppClient(
    requiredEnv("CREDENTIAL_KEK"), fetch, Date.now, process.env.RUNTIME_ASSURANCE_ADMIN_URL,
  );
  try {
    await runSchedulerLoop({
      db, intervalMs, signal: controller.signal, health,
      tick: async () => runScheduledOperationalTasks({
        renewals: () => observe("subscription_renewal", "订阅自动续记", async () => {
          const result = await runSubscriptionRenewalTick({ db });
          console.log(JSON.stringify({ event: "subscription_auto_renewal_tick", ...result }));
          return result;
        }, result => "skipped" in result ? null : result.failures.length === 0),
        onRenewalError: (cause) => console.error(JSON.stringify({
          event: "subscription_auto_renewal_tick_failed", error_type: cause instanceof Error ? cause.name : typeof cause,
        })),
        core: async () => {
          await runInfrastructureChecks({ db, observe });
          const runtime = await runRuntimeAssuranceTick({ repository, wecom, wecomNotify: wecomNotifyEnabled() });
          const forecast = await runSupplyForecastTick(supplyForecastRepository);
          // POOL-032：厂商 Coding Plan 额度窗口同步（失败保鲜，不影响 runtime/forecast）。
          const quota = await runCodingPlanQuotaTick({ db, kekBase64: requiredEnv("CREDENTIAL_KEK") });
          const operating = await runProviderOperatingSyncTick({
            db, kekBase64: requiredEnv("CREDENTIAL_KEK"),
          });
          console.log(JSON.stringify({
            event: "supply_forecast_tick_completed",
            resources_scanned: forecast.resourcesScanned,
            snapshots_created: forecast.snapshotsCreated,
            snapshots_skipped: forecast.snapshotsSkipped,
          }));
          console.log(JSON.stringify({
            event: "quota_window_tick_completed",
            resources_scanned: quota.resourcesScanned,
            windows_upserted: quota.windowsUpserted,
            resources_recovered: quota.resourcesRecovered,
            failed: quota.failed,
          }));
          console.log(JSON.stringify({ event: "provider_operating_sync_tick_completed", ...operating }));
          if (readFeatureFlags(process.env).FEATURE_DIRECTORY_IMPORT) {
            try {
              const dirSync = await runDirectorySyncTick({
                db,
                kekBase64: requiredEnv("CREDENTIAL_KEK"),
              });
              if (dirSync.runsScanned > 0) {
                console.log(JSON.stringify({ event: "directory_sync_tick_completed", ...dirSync }));
              }
            } catch (error) {
              console.error(JSON.stringify({
                event: "directory_sync_tick_failed",
                error_type: error instanceof Error ? error.name : typeof error,
                message: error instanceof Error ? error.message : String(error),
              }));
            }
          }
          return { runtime, forecast, quota, operating };
        },
        aggregate: () => observe("usage_aggregate", "用量聚合重建", async () => {
          const now = new Date();
          const shanghaiDate = new Intl.DateTimeFormat("en-CA", {
            timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
          }).format(now);
          const includeDaily = lastDailyAggregateDate !== shanghaiDate;
          const aggregate = await runUsageAggregateTick({
            repository: usageAggregateRepository, now, includeDaily,
            dirtyLimit: aggregateDirtyLimit,
          });
          if (includeDaily) lastDailyAggregateDate = shanghaiDate;
          console.log(JSON.stringify({
            event: "usage_aggregate_tick_completed", dirty_limit: aggregateDirtyLimit,
            include_daily: includeDaily, ...aggregate,
          }));
          return aggregate;
        }),
        onAggregateError: (cause) => console.error(JSON.stringify({
          event: "usage_aggregate_tick_failed",
          error_type: cause instanceof Error ? cause.name : typeof cause,
          dirty_limit: aggregateDirtyLimit,
        })),
      }),
    });
  } finally {
    await new Promise<void>((resolve) => healthServer.close(() => resolve()));
    await db.destroy();
  }
}

async function runProviderOperatingSyncOnce(): Promise<void> {
  const db = createKysely();
  try {
    const result = await runProviderOperatingSyncTick({
      db, kekBase64: requiredEnv("CREDENTIAL_KEK"),
    });
    console.log(JSON.stringify({ event: "provider_operating_sync_once_completed", ...result }));
  } finally {
    await db.destroy();
  }
}

async function runSupplyForecastOnce(): Promise<void> {
  const db = createKysely();
  try {
    const result = await runSupplyForecastTick(new SupplyForecastRepository(db));
    console.log(JSON.stringify({
      event: "supply_forecast_tick_completed",
      resources_scanned: result.resourcesScanned,
      snapshots_created: result.snapshotsCreated,
      snapshots_skipped: result.snapshotsSkipped,
    }));
  } finally {
    await db.destroy();
  }
}

async function runDirectorySyncOnce(args: string[]): Promise<void> {
  if (!readFeatureFlags(process.env).FEATURE_DIRECTORY_IMPORT) {
    throw new Error("FEATURE_DIRECTORY_IMPORT=false，directory sync worker 未启用");
  }
  const maxRunsRaw = arg(args, "--max-runs");
  const maxRuns = maxRunsRaw === undefined ? undefined : Number(maxRunsRaw);
  if (maxRuns !== undefined && (!Number.isInteger(maxRuns) || maxRuns < 1 || maxRuns > 100)) {
    throw new Error("directory-sync-once --max-runs 必须为 1-100 的整数");
  }
  const db = createKysely();
  try {
    const result = await runDirectorySyncTick({
      db,
      kekBase64: requiredEnv("CREDENTIAL_KEK"),
      runId: arg(args, "--run"),
      maxRuns,
    });
    console.log(JSON.stringify({
      event: "directory_sync_once_completed",
      runs_scanned: result.runsScanned,
      snapshots_pulled: result.snapshotsPulled,
      apply_runs_completed: result.applyRunsCompleted,
      succeeded: result.succeeded,
      partial: result.partial,
      failed: result.failed,
      deferred: result.deferred,
    }));
  } finally {
    await db.destroy();
  }
}

async function runUsageAggregateRebuild(args: string[]): Promise<void> {
  const enterpriseId = arg(args, "--enterprise");
  const fromRaw = arg(args, "--from");
  const toRaw = arg(args, "--to");
  const from = fromRaw ? new Date(fromRaw) : null;
  const to = toRaw ? new Date(toRaw) : null;
  if (!enterpriseId || !from || !to
    || !Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()) || from >= to) {
    throw new Error("usage-aggregate-rebuild 需要 --enterprise 与有效的 --from/--to 半开时间范围");
  }
  const db = createKysely();
  try {
    const result = await new UsageAggregateRepository(db).rebuildRange({
      enterpriseId, from, to,
    });
    console.log(JSON.stringify({
      event: "usage_aggregate_rebuild_completed",
      enterprise_id: result.enterpriseId,
      timezone: result.timezone,
      range_from: result.from.toISOString(),
      range_to: result.to.toISOString(),
      hour_buckets: result.hourBuckets,
      day_buckets: result.dayBuckets,
      rows_written: result.rowsWritten,
      rows_removed: result.rowsRemoved,
    }));
  } finally {
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
