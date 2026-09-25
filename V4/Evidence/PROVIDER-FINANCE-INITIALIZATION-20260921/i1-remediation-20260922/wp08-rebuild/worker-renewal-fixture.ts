/**
 * WP08 7.3 Worker 静默跳过 / 到期恢复 演练夹具（在**候选 worker 容器内**执行）。
 *
 * 为什么在容器内跑：本脚本要证明的是**候选镜像里的 Worker 代码**会跳过静默企业，
 * 而不是宿主机工作区的代码。容器内 `node --import tsx` 直接加载 worker 镜像自带的
 * `@qianliu/database`，与 worker 进程使用的是同一份构建产物。
 *
 * 用法（容器内）：
 *   node --import tsx wp08-worker-fixture.ts fixture   建合成订阅（B 企业，本地一次性）
 *   node --import tsx wp08-worker-fixture.ts tick      跑一次自动续订 tick（真实 worker 入口）
 *   node --import tsx wp08-worker-fixture.ts gate      打印 Worker 共享静默门禁
 *
 * 仅作用于本地一次性合成库；不触碰任何真实业务数据。
 */
import { createKysely, ProviderFinanceRepository, listQuiescentEnterpriseIds, runSubscriptionAutoRenewals } from "@qianliu/database";

/** 由演练脚本注入（正向激活池里的那一家）；缺失即失败关闭，避免误操作到别的企业。 */
function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`缺少环境变量 ${name}`);
  return value;
}
const ENT = required("WP08_ENT");
const ADMIN = required("WP08_ADMIN");
const PROVIDER_ID = required("WP08_PROV");
const RESOURCE_ID = required("WP08_RES");
const IDEM = required("WP08_IDEM");
const PRODUCT = "WP08-SIM Coding Plan";
const AMOUNT = "199";

/** 上海自然日零点 → UTC。参数为上海日历日期字符串。 */
function shanghaiMidnight(day: string): Date {
  return new Date(`${day}T00:00:00+08:00`);
}
/** 当前上海日历日期（YYYY-MM-DD）。 */
function shanghaiToday(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai",
    year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}
function addDays(day: string, delta: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

/** 机器可读单行输出（便于演练脚本稳定解析），人类可读摘要另起一行。 */
function emit(label: string, payload: unknown): void {
  console.log(`WP08JSON ${JSON.stringify(payload)}`);
  console.log(`${label}\n${JSON.stringify(payload, null, 1)}`);
}

async function main(): Promise<void> {
  const mode = process.argv[2] ?? "gate";
  const db = createKysely(process.env.DATABASE_URL!);
  try {
    if (mode === "fixture") {
      const today = shanghaiToday();
      const start = shanghaiMidnight(addDays(today, -1));
      const end = shanghaiMidnight(today);
      const providerExists = await db.selectFrom("provider").select("id")
        .where("id", "=", PROVIDER_ID).executeTakeFirst();
      if (!providerExists) {
        await db.insertInto("provider").values({
          id: PROVIDER_ID, enterprise_id: ENT, code: "wp08-sim-coding", name: "WP08-SIM Coding",
          adapter_type: "CODING_PLAN",
        }).execute();
      }
      const resourceExists = await db.selectFrom("provider_resource").select("id")
        .where("id", "=", RESOURCE_ID).executeTakeFirst();
      if (!resourceExists) {
        await db.insertInto("provider_resource").values({
          id: RESOURCE_ID, enterprise_id: ENT, provider_id: PROVIDER_ID,
          name: "WP08-SIM Coding Plan", mode: "CODING_PLAN", credential_type: "SUBSCRIPTION_SESSION",
          status: "ACTIVE", subscription_auto_renew_enabled: true,
        }).execute();
      }
      const repo = new ProviderFinanceRepository(db);
      const written = await repo.recordSubscription({
        enterpriseId: ENT, resourceId: RESOURCE_ID, adminId: ADMIN, kind: "PURCHASE",
        productName: PRODUCT, accountAmount: AMOUNT, accountCurrency: "CNY",
        cashPaidCny: AMOUNT, occurredAt: start, periodStart: start, periodEndExclusive: end,
        idempotencyKey: IDEM,
      });
      emit("-- fixture:", {
        mode, todayShanghai: today, templatePeriod: [start.toISOString(), end.toISOString()],
        eventId: written.event.id, resourceId: RESOURCE_ID,
      });
      return;
    }
    if (mode === "gate") {
      emit("-- gate:", { listQuiescentEnterpriseIds: await listQuiescentEnterpriseIds(db, new Date()) });
      return;
    }
    if (mode === "tick") {
      const tick = await runSubscriptionAutoRenewals(db, new Date());
      emit("-- tick:", { tick });
      return;
    }
    if (mode === "events") {
      const rows = await db.selectFrom("provider_finance_event")
        .select(["id", "event_type", "source", "cash_paid_cny", "occurred_at"])
        .where("enterprise_id", "=", ENT).orderBy("occurred_at", "asc").execute();
      emit("-- events:", { events: rows });
      return;
    }
    throw new Error(`未知模式: ${mode}`);
  } finally {
    await db.destroy();
  }
}

main().catch((error) => {
  console.error("FIXTURE_FAIL", error instanceof Error ? error.message : String(error));
  process.exit(1);
});
