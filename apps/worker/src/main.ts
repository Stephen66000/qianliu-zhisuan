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
import { readFeatureFlags, WECOM_API_ORIGIN } from "@qianliu/config";
import { generateOperatingBill } from "./operating-bill/runner.js";
import {
  decodeKek,
  encryptCredential,
  decryptCredential,
  credentialFingerprint,
  type EncryptedCredential,
} from "@qianliu/provider-adapters";
import { WecomAppClient } from "./runtime-assurance/wecom-client.js";
import { runRuntimeAssuranceTick } from "./runtime-assurance/runner.js";
import { runSchedulerLoop, startHealthServer, type SchedulerHealth } from "./runtime-assurance/scheduler.js";
import { runScheduledOperationalTasks } from "./runtime-assurance/scheduled-tasks.js";
import { runSupplyForecastTick } from "./supply-forecast/runner.js";
import { runCodingPlanQuotaTick } from "./coding-plan-quota/runner.js";
import { runDirectorySyncTick } from "./directory/runner.js";
import { runProviderOperatingSyncTick } from "./provider-operating-sync/runner.js";
import { runUsageAggregateTick } from "./usage-aggregate/runner.js";
import { createClient } from "redis";
import {
  runDailyTokenReport,
  runCompanyWeeklyReport,
  runPersonalWeeklyReports,
  runIncentiveChecks,
  dispatchAllCardsToUser,
  RedisMilestoneStore,
  MemoryMilestoneStore,
  type MilestoneStore,
} from "./reporting/index.js";

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

  if (command === "daily-token-report") {
    await runDailyTokenReportCommand(args.slice(1));
    return;
  }

  if (command === "report-company-weekly") {
    await runReportCompanyWeeklyCommand(args.slice(1));
    return;
  }

  if (command === "report-personal-weekly") {
    await runReportPersonalWeeklyCommand(args.slice(1));
    return;
  }

  if (command === "check-incentives") {
    await runCheckIncentivesCommand(args.slice(1));
    return;
  }

  if (command === "activate-wecom-endpoint") {
    await runActivateWecomEndpointCommand(args.slice(1));
    return;
  }

  if (command === "dispatch-user-cards" || command === "send-user-cards") {
    await runDispatchUserCardsCommand(args.slice(1));
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
  console.log("[worker]       worker daily-token-report [--enterprise <id>] [--date <YYYY-MM-DD>] [--recipients <u1,u2>] [--dry-run]");
  console.log("[worker]       worker report-company-weekly [--enterprise <id>] [--week <YYYY-Www>] [--recipients <u1,u2> | --user <name>] [--dry-run]");
  console.log("[worker]       worker report-personal-weekly --enterprise <id> [--user <person-id|name|wecom-id>] [--dry-run]");
  console.log("[worker]       worker check-incentives --enterprise <id> [--dry-run] [--force]");
  console.log("[worker]       worker activate-wecom-endpoint --agent-id <agent-id> [--secret <secret>] [--corp-id <corp-id>]");
  console.log("[worker]       worker dispatch-user-cards <员工姓名|企微账号> [--dry-run]");
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

async function redisSafeGet(client: ReturnType<typeof createClient> | null, key: string): Promise<string | null> {
  if (!client || !client.isOpen) return null;
  try {
    return await client.get(key);
  } catch {
    return null;
  }
}

async function redisSafeSet(client: ReturnType<typeof createClient> | null, key: string, val: string, ttlSeconds: number): Promise<void> {
  if (!client || !client.isOpen) return;
  try {
    await client.set(key, val, { EX: ttlSeconds });
  } catch {
    // ignore
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
  let lastDailyReportDate: string | null = null;
  let lastWeeklyReportDate: string | null = null;
  let lastIncentiveCheckDate: string | null = null;
  const wecom = new WecomAppClient(
    requiredEnv("CREDENTIAL_KEK"), fetch, Date.now, process.env.RUNTIME_ASSURANCE_ADMIN_URL,
  );

  let redisClient: ReturnType<typeof createClient> | null = null;
  const redisUrl = process.env.REDIS_URL;
  if (redisUrl) {
    try {
      const client = createClient({
        url: redisUrl,
        socket: { connectTimeout: 3000, reconnectStrategy: (retries) => Math.min(retries * 50, 1000) },
      });
      client.on("error", (err) => {
        console.warn(JSON.stringify({
          event: "redis_scheduler_client_error",
          message: err instanceof Error ? err.message : String(err),
        }));
      });
      await client.connect();
      redisClient = client;
      console.log(JSON.stringify({ event: "redis_scheduler_client_connected", url: redisUrl }));
    } catch (err) {
      console.warn(JSON.stringify({
        event: "redis_scheduler_client_init_failed",
        message: err instanceof Error ? err.message : String(err),
      }));
    }
  }

  const milestoneStore: MilestoneStore = redisClient
    ? new RedisMilestoneStore(redisClient)
    : new MemoryMilestoneStore();
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
        // eslint-disable-next-line complexity -- 已登记例外（2026-09-14 I1 审核）：用量聚合编排分支密集，随 main.ts 859 行体量拆分（F-P2-3）一并处理。
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

          const shanghaiHour = Number(
            new Intl.DateTimeFormat("en-US", {
              timeZone: "Asia/Shanghai",
              hour: "numeric",
              hour12: false,
            }).format(now),
          );
          const shanghaiMinute = Number(
            new Intl.DateTimeFormat("en-US", {
              timeZone: "Asia/Shanghai",
              minute: "numeric",
            }).format(now),
          );
          const shanghaiDay = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Shanghai" })).getDay();

          // 每日上午 09:00 ~ 09:30（上海时间）自动生成昨日全员 Token 消费长图并推送指定人
          const isDailyReportWindow = shanghaiHour === 9 && shanghaiMinute < 30;
          if (isDailyReportWindow && lastDailyReportDate !== shanghaiDate) {
            try {
              const enterprises = await db
                .selectFrom("enterprise")
                .select("id")
                .where("status", "=", "ACTIVE")
                .execute();
              for (const ent of enterprises) {
                const redisDailyKey = `scheduler:daily_report:${ent.id}:${shanghaiDate}`;
                const alreadyDone = await redisSafeGet(redisClient, redisDailyKey);
                if (alreadyDone) continue;

                const reportResult = await runDailyTokenReport({
                  db,
                  kekBase64: requiredEnv("CREDENTIAL_KEK"),
                  enterpriseId: ent.id,
                });
                await redisSafeSet(redisClient, redisDailyKey, "1", 86400 * 2);
                console.log(JSON.stringify({
                  event: "daily_token_report_scheduler_completed",
                  enterprise_id: ent.id,
                  status: reportResult.status,
                  recipients: reportResult.recipients,
                  media_id: reportResult.mediaId,
                }));
              }
              lastDailyReportDate = shanghaiDate;
            } catch (error) {
              console.error(JSON.stringify({
                event: "daily_token_report_scheduler_failed",
                error_type: error instanceof Error ? error.name : typeof error,
                message: error instanceof Error ? error.message : String(error),
              }));
            }
          }

          // 每周一上午 09:00 ~ 09:30（上海时间）推送团队全员周报与员工个人周报
          // 严格限定在周一早 09:00~09:30，超过时间段即使重启也绝不补发打扰
          const isWeeklyReportWindow = shanghaiDay === 1 && shanghaiHour === 9 && shanghaiMinute < 30;
          if (isWeeklyReportWindow && lastWeeklyReportDate !== shanghaiDate) {
            try {
              const enterprises = await db
                .selectFrom("enterprise")
                .select("id")
                .where("status", "=", "ACTIVE")
                .execute();
              for (const ent of enterprises) {
                const redisWeeklyKey = `scheduler:weekly_report:${ent.id}:${shanghaiDate}`;
                const alreadyDone = await redisSafeGet(redisClient, redisWeeklyKey);
                if (alreadyDone) continue;

                const companyResult = await runCompanyWeeklyReport({
                  db,
                  kekBase64: requiredEnv("CREDENTIAL_KEK"),
                  enterpriseId: ent.id,
                });
                console.log(JSON.stringify({
                  event: "company_weekly_report_scheduler_completed",
                  enterprise_id: ent.id,
                  status: companyResult.status,
                }));
                const personalResults = await runPersonalWeeklyReports({
                  db,
                  kekBase64: requiredEnv("CREDENTIAL_KEK"),
                  enterpriseId: ent.id,
                });
                console.log(JSON.stringify({
                  event: "personal_weekly_report_scheduler_completed",
                  enterprise_id: ent.id,
                  count: personalResults.length,
                }));
                await redisSafeSet(redisClient, redisWeeklyKey, "1", 86400 * 7);
              }
              lastWeeklyReportDate = shanghaiDate;
            } catch (error) {
              console.error(JSON.stringify({
                event: "weekly_token_report_scheduler_failed",
                error_type: error instanceof Error ? error.name : typeof error,
                message: error instanceof Error ? error.message : String(error),
              }));
            }
          }

          // 周三至周日上午 09:30 ~ 09:59（上海时间）执行激励巡检（登顶流动红旗与超越50%员工成长卡）
          // 严格限定在上午 09:30~09:59 触发，下午或晚上即使服务重启也绝对不触发
          const isWedToSun = shanghaiDay === 0 || shanghaiDay >= 3;
          const isIncentiveWindow = shanghaiHour === 9 && shanghaiMinute >= 30;
          if (isWedToSun && isIncentiveWindow && lastIncentiveCheckDate !== shanghaiDate) {
            try {
              const enterprises = await db
                .selectFrom("enterprise")
                .select("id")
                .where("status", "=", "ACTIVE")
                .execute();
              for (const ent of enterprises) {
                const redisIncentiveKey = `scheduler:incentive_check:${ent.id}:${shanghaiDate}`;
                const alreadyDone = await redisSafeGet(redisClient, redisIncentiveKey);
                if (alreadyDone) continue;

                const incentiveResult = await runIncentiveChecks({
                  db,
                  kekBase64: requiredEnv("CREDENTIAL_KEK"),
                  enterpriseId: ent.id,
                  milestoneStore,
                });
                await redisSafeSet(redisClient, redisIncentiveKey, "1", 86400 * 2);
                console.log(JSON.stringify({
                  event: "incentive_check_scheduler_completed",
                  enterprise_id: ent.id,
                  top1_triggered: incentiveResult.top1Result?.triggered,
                  over50_count: incentiveResult.over50Results?.filter((r) => r.triggered).length ?? 0,
                }));
              }
              lastIncentiveCheckDate = shanghaiDate;
            } catch (error) {
              console.error(JSON.stringify({
                event: "incentive_check_scheduler_failed",
                error_type: error instanceof Error ? error.name : typeof error,
                message: error instanceof Error ? error.message : String(error),
              }));
            }
          }

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
    if (redisClient?.isOpen) {
      await redisClient.quit().catch(() => undefined);
    }
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

async function runDailyTokenReportCommand(args: string[]): Promise<void> {
  const db = createKysely();
  try {
    let enterpriseId = arg(args, "--enterprise");
    if (!enterpriseId) {
      const ent = await db.selectFrom("enterprise").select("id").limit(1).executeTakeFirst();
      enterpriseId = ent?.id;
    }
    if (!enterpriseId) {
      console.error("[worker] 缺少 --enterprise 参数且系统中未找到企业");
      process.exit(1);
    }

    const dateStr = arg(args, "--date");
    const targetDate = dateStr ? new Date(`${dateStr}T00:00:00+08:00`) : undefined;
    const recipientsRaw = arg(args, "--recipients");
    const recipients = recipientsRaw ? recipientsRaw.split(",").map((s) => s.trim()).filter(Boolean) : undefined;
    const dryRun = args.includes("--dry-run");

    const result = await runDailyTokenReport({
      db,
      kekBase64: requiredEnv("CREDENTIAL_KEK"),
      enterpriseId,
      targetDate,
      recipients,
      dryRun,
    });

    console.log("[worker] 每日 Token 消费日报执行完成:", JSON.stringify(result, null, 2));
  } finally {
    await db.destroy();
  }
}

async function runReportCompanyWeeklyCommand(args: string[]): Promise<void> {
  const db = createKysely();
  try {
    let enterpriseId = arg(args, "--enterprise");
    if (!enterpriseId) {
      const ent = await db.selectFrom("enterprise").select("id").limit(1).executeTakeFirst();
      enterpriseId = ent?.id;
    }
    if (!enterpriseId) {
      console.error("[worker] 缺少 --enterprise 参数且系统中未找到企业");
      process.exit(1);
    }

    const weekStr = arg(args, "--week");
    const targetDate = weekStr ? new Date(weekStr) : undefined;
    const recipientsRaw = arg(args, "--recipients") ?? arg(args, "--user");
    const recipients = recipientsRaw ? recipientsRaw.split(",").map((s) => s.trim()).filter(Boolean) : undefined;
    const dryRun = args.includes("--dry-run");

    const result = await runCompanyWeeklyReport({
      db,
      kekBase64: requiredEnv("CREDENTIAL_KEK"),
      enterpriseId,
      targetDate,
      recipients,
      dryRun,
    });

    console.log("[worker] 团队全员用量周报执行完成:", JSON.stringify({
      enterpriseName: result.enterpriseName,
      dateRange: result.dateRange,
      totalTokens: result.totalTokens,
      requestCount: result.requestCount,
      activeEmployees: result.activeEmployees,
      recipients: result.recipients,
      status: result.status,
      mediaId: result.mediaId,
    }, null, 2));
  } finally {
    await db.destroy();
  }
}

async function runReportPersonalWeeklyCommand(args: string[]): Promise<void> {
  const db = createKysely();
  try {
    let enterpriseId = arg(args, "--enterprise");
    if (!enterpriseId) {
      const ent = await db.selectFrom("enterprise").select("id").limit(1).executeTakeFirst();
      enterpriseId = ent?.id;
    }
    if (!enterpriseId) {
      console.error("[worker] 缺少 --enterprise 参数且系统中未找到企业");
      process.exit(1);
    }

    const userPersonId = arg(args, "--user");
    const dryRun = args.includes("--dry-run");

    const results = await runPersonalWeeklyReports({
      db,
      kekBase64: requiredEnv("CREDENTIAL_KEK"),
      enterpriseId,
      userPersonId,
      dryRun,
    });

    console.log(`[worker] 员工个人周报执行完成 (共 ${results.length} 人):`, JSON.stringify(results.map((r) => ({
      userName: r.userName,
      tokens: r.totalTokens,
      requests: r.requestCount,
      status: r.status,
      mediaId: r.mediaId,
    })), null, 2));
  } finally {
    await db.destroy();
  }
}

async function runCheckIncentivesCommand(args: string[]): Promise<void> {
  const db = createKysely();
  try {
    let enterpriseId = arg(args, "--enterprise");
    if (!enterpriseId) {
      const ent = await db.selectFrom("enterprise").select("id").limit(1).executeTakeFirst();
      enterpriseId = ent?.id;
    }
    if (!enterpriseId) {
      console.error("[worker] 缺少 --enterprise 参数且系统中未找到企业");
      process.exit(1);
    }

    const dryRun = args.includes("--dry-run");
    const force = args.includes("--force");

    const result = await runIncentiveChecks({
      db,
      kekBase64: requiredEnv("CREDENTIAL_KEK"),
      enterpriseId,
      dryRun,
      force,
    });

    console.log("[worker] 激励巡检执行完成:", JSON.stringify({
      enterpriseId: result.enterpriseId,
      top1Result: result.top1Result,
      over50Count: result.over50Results?.length ?? 0,
      over50Results: result.over50Results?.map((r) => ({
        userName: r.userName,
        tokens: r.tokens,
        triggered: r.triggered,
        reason: r.reason,
      })),
    }, null, 2));
  } finally {
    await db.destroy();
  }
}

async function runActivateWecomEndpointCommand(args: string[]): Promise<void> {
  const db = createKysely();
  try {
    const agentId = arg(args, "--agent-id");
    if (!agentId) {
      console.error("[worker] 缺少 --agent-id 参数。用法：worker activate-wecom-endpoint --agent-id <agent_id> [--secret <secret>] [--corp-id <corp_id>]");
      process.exit(1);
    }

    const kekBase64 = process.env.CREDENTIAL_KEK || process.env.CREDENTIAL_ENCRYPTION_KEY_BASE64;
    if (!kekBase64) {
      console.error("[worker] 缺少 CREDENTIAL_KEK 环境变量");
      process.exit(1);
    }
    const kekBuf = decodeKek(kekBase64);

    let corpId = arg(args, "--corp-id");
    let secret = arg(args, "--secret");

    // 若未显式传入 corp-id 或 secret，则自动从已配置并激活的 directory_source 读取
    if (!corpId || !secret) {
      const source = await db
        .selectFrom("directory_source")
        .selectAll()
        .where("type", "=", "WECOM")
        .where("status", "=", "ACTIVE")
        .orderBy("created_at", "desc")
        .executeTakeFirst();

      if (!source) {
        console.error("[worker] 系统中未找到处于 ACTIVE 状态的企业微信通讯录配置 (directory_source)。请通过 --corp-id 和 --secret 手动指定。");
        process.exit(1);
      }

      try {
        const envelope = JSON.parse(source.config_ciphertext) as EncryptedCredential;
        const decrypted = decryptCredential(envelope, kekBuf);
        const cfg = JSON.parse(decrypted) as { corp_id?: string; corp_secret?: string; secret?: string };
        if (!corpId) corpId = cfg.corp_id;
        if (!secret) secret = cfg.corp_secret || cfg.secret;
      } catch (err: unknown) {
        console.error("[worker] 解密 directory_source 企业微信凭证失败:",
          err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    }

    if (!corpId || !secret) {
      console.error("[worker] 未能获取到有效的 corp_id 或 secret。请检查输入或补充参数。");
      process.exit(1);
    }

    console.log(`[worker] 正在校验企业微信自建应用连通性 (CorpID: ${corpId}, AgentID: ${agentId})...`);

    // 调用企微 gettoken 接口做真实性与连通性校验
    const tokenUrl = new URL(`${WECOM_API_ORIGIN}/cgi-bin/gettoken`);
    tokenUrl.searchParams.set("corpid", corpId);
    tokenUrl.searchParams.set("corpsecret", secret);

    const res = await fetch(tokenUrl.toString());
    const data = (await res.json()) as { errcode?: number; errmsg?: string; access_token?: string; expires_in?: number };

    if (data.errcode !== 0 || !data.access_token) {
      console.error(`[worker] ❌ 企微 Token 获取失败: errcode=${data.errcode}, errmsg=${data.errmsg}`);
      if (data.errcode === 40001 || data.errcode === 40014) {
        console.error("[worker] 提示：在企业微信中，自建应用拥有其专属的应用 Secret (在应用详情页查看)。");
        console.error("[worker]       若与通讯录 Secret 不同，请运行：");
        console.error(`[worker]       worker activate-wecom-endpoint --agent-id ${agentId} --secret <应用Secret>`);
      }
      process.exit(1);
    }

    console.log(`[worker] ✅ 企微 API 校验通过！成功取得 access_token (有效时长: ${data.expires_in ?? 7200} 秒)`);

    // 对 Secret 执行 AES-256-GCM 加密，并计算 16 位安全指纹
    const encrypted = encryptCredential(secret, kekBuf);
    const secretFingerprint = credentialFingerprint(secret);

    // 查询是否存在现有 WECOM_APP 通道记录
    const existing = await db
      .selectFrom("notification_endpoint")
      .selectAll()
      .where("provider", "=", "WECOM_APP")
      .executeTakeFirst();

    if (existing) {
      await db
        .updateTable("notification_endpoint")
        .set({
          corp_id: corpId,
          agent_id: agentId,
          secret_ciphertext: JSON.stringify(encrypted),
          secret_fingerprint: secretFingerprint,
          status: "ACTIVE",
          version: existing.version + 1,
          updated_at: new Date(),
        })
        .where("id", "=", existing.id)
        .execute();
      console.log(`[worker] ✅ 已成功更新现有 notification_endpoint (ID: ${existing.id}) -> 状态置为 ACTIVE`);
    } else {
      const inserted = await db
        .insertInto("notification_endpoint")
        .values({
          provider: "WECOM_APP",
          corp_id: corpId,
          agent_id: agentId,
          secret_ciphertext: JSON.stringify(encrypted),
          secret_fingerprint: secretFingerprint,
          status: "ACTIVE",
          version: 1,
        })
        .returning("id")
        .executeTakeFirst();
      console.log(`[worker] ✅ 已成功新建 notification_endpoint (ID: ${inserted?.id}) -> 状态置为 ACTIVE`);
    }

    console.log("[worker] 🎉 企业微信自建应用通知通道已完全激活！即刻起支持高清看板长图与激励信笺真机下发。");
  } finally {
    await db.destroy();
  }
}

async function runDispatchUserCardsCommand(args: string[]): Promise<void> {
  const targetUser =
    arg(args, "--recipient") ??
    arg(args, "--name") ??
    arg(args, "--target") ??
    arg(args, "--user") ??
    args.find((a) => !a.startsWith("-"));

  console.log(`[worker] 🚀 收到全套卡片定向下发指令 (目标: ${targetUser ?? "未指定"})`);

  if (!targetUser) {
    console.error("[worker] ❌ 缺少目标员工参数。用法：worker dispatch-user-cards <员工姓名|企微账号> 或 --recipient <姓名>");
    process.exit(1);
  }

  const db = createKysely();
  try {
    let enterpriseId = arg(args, "--enterprise");
    if (!enterpriseId) {
      const ent = await db.selectFrom("enterprise").select("id").limit(1).executeTakeFirst();
      enterpriseId = ent?.id;
    }
    if (!enterpriseId) {
      console.error("[worker] ❌ 缺少 --enterprise 参数且系统中未找到企业");
      process.exit(1);
    }

    const dryRun = args.includes("--dry-run");

    const result = await dispatchAllCardsToUser({
      db,
      kekBase64: requiredEnv("CREDENTIAL_KEK"),
      enterpriseId,
      targetUser,
      dryRun,
    });

    console.log(`\n[worker] 🎉 员工 [${result.targetUser}] 全套 5 款卡片下发完成:`);
    console.log(JSON.stringify({
      targetUser: result.targetUser,
      providerUserId: result.providerUserId,
      enterpriseName: result.enterpriseName,
      summary: result.results.map((c) => ({
        卡片: c.title,
        状态: c.status,
        详情: c.detail ?? (c.status === "SENT" ? "已送达企微" : "—"),
      })),
    }, null, 2));
  } finally {
    await db.destroy();
  }
}

main().catch((err) => {
  console.error("[worker] 启动失败:", err);
  process.exit(1);
});
