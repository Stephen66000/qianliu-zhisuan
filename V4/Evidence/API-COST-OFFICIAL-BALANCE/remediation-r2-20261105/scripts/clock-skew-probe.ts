/**
 * R2-1 时钟探针（返修轮 R2 合同 C1）：实测 DB 侧 now()/clock_timestamp() 与 Node 宿主
 * Date.now() 的同刻偏差。
 *
 * 背景：R1 复审 C1／R8a 归因「宿主-testcontainer 时钟偏移 ~1.2s」曾致 AT-X02 三连假阴性
 * （R1 证据探针 /tmp/atx02-probe.cjs 未入档，本脚本为其入档重做版）。R2 根治后
 * convergeExpiredLeases 判定基准已改 DB 侧 now()（见
 * packages/database/src/repositories/official-balance-refresh-repository.ts），
 * 本探针用于：
 *   1) 量化目标库与 Node 宿主的时钟偏差（skew_ms = DB 时钟 - 宿主时钟中点）；
 *   2) 留档同刻时间戳（同一语句内的 clock_timestamp() 文本 vs 宿主 ISO 时间）。
 *
 * 只读探针：仅执行 SELECT，零写入。
 *
 * 运行（worktree 根）：
 *   DOCKER_HOST=unix:///Users/mac/.colima/default/docker.sock \
 *   corepack pnpm@11.11.0 exec tsx \
 *   V4/Evidence/API-COST-OFFICIAL-BALANCE/remediation-r2-20261105/scripts/clock-skew-probe.ts \
 *   [--url postgresql://user:pass@host:port/db] [--testcontainer] [--samples 9]
 *
 *   默认（无参数）对常驻 qianliu-pg（宿主端口 55432）实测；--testcontainer 用
 *   @qianliu/testing 的 startPostgresContainer（与集成测试同一镜像 digest）另起临时
 *   testcontainer 实测。
 */
import { sql } from "/Users/mac/Projects/仟流智算-api-decouple/packages/database/node_modules/kysely/dist/esm/index.js";
import { createKysely } from "/Users/mac/Projects/仟流智算-api-decouple/packages/database/src/kysely.ts";
import { startPostgresContainer, type PostgresTestInstance } from "/Users/mac/Projects/仟流智算-api-decouple/packages/testing/src/postgres-container.ts";

interface Sample {
  i: number;
  host_before_ms: number;
  host_after_ms: number;
  host_mid_ms: number;
  db_ms: number;
  skew_ms: number;
  db_clock_text: string;
  host_mid_iso: string;
  rtt_ms: number;
}

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const samples = Math.max(1, Number(arg("--samples") ?? 9));
  let pg: PostgresTestInstance | null = null;
  let url = arg("--url") ?? process.env.PROBE_DATABASE_URL;
  if (arg("--testcontainer")) {
    pg = await startPostgresContainer();
    url = pg.connectionString;
  }
  if (!url) {
    // 常驻开发库 qianliu-pg（deploy/compose 同款 postgres:17-alpine，宿主端口 55432）。
    url = "postgresql://postgres:qianliu@127.0.0.1:55432/qianliu";
  }
  const db = createKysely(url);
  try {
    const meta = await sql<{ db_ts: string; tz: string; version: string }>`
      SELECT clock_timestamp()::text AS db_ts, current_setting('TimeZone') AS tz,
             current_setting('server_version') AS version
    `.execute(db);
    console.log(JSON.stringify({
      probe: "clock-skew-probe (R2-1 / C1)",
      target: arg("--testcontainer") ? "temp-testcontainer (postgres:17-alpine, @qianliu/testing digest)"
        : (arg("--url") ?? process.env.PROBE_DATABASE_URL ? "explicit-url" : "qianliu-pg 127.0.0.1:55432/qianliu"),
      node: process.version,
      nodeTZ: Intl.DateTimeFormat().resolvedOptions().timeZone,
      dockerHost: process.env.DOCKER_HOST ?? "(unset)",
      dbServerVersion: meta.rows[0]!.version,
      dbTimeZone: meta.rows[0]!.tz,
      dbClockFirstRead: meta.rows[0]!.db_ts,
      samples,
    }));

    const results: Sample[] = [];
    for (let i = 0; i < samples; i++) {
      const before = Date.now();
      const r = await sql<{ db_ms: string; db_ts: string }>`
        SELECT extract(epoch FROM clock_timestamp()) * 1000 AS db_ms,
               clock_timestamp()::text AS db_ts
      `.execute(db);
      const after = Date.now();
      const dbMs = Number(r.rows[0]!.db_ms);
      const mid = (before + after) / 2;
      const sample: Sample = {
        i,
        host_before_ms: before,
        host_after_ms: after,
        host_mid_ms: mid,
        db_ms: dbMs,
        skew_ms: Math.round((dbMs - mid) * 1000) / 1000,
        db_clock_text: r.rows[0]!.db_ts,
        host_mid_iso: new Date(mid).toISOString(),
        rtt_ms: after - before,
      };
      results.push(sample);
      console.log(JSON.stringify(sample));
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
    const skews = results.map((s) => s.skew_ms);
    const mean = skews.reduce((a, b) => a + b, 0) / skews.length;
    const summary = {
      skew_min_ms: Math.min(...skews),
      skew_max_ms: Math.max(...skews),
      skew_mean_ms: Math.round(mean * 1000) / 1000,
      /** 方向约定：skew > 0 ＝ DB 时钟领先宿主（宿主落后），与 R8a「宿主-testcontainer 偏移」一致。 */
      direction: mean > 0 ? "DB_LEADS_HOST" : mean < 0 ? "HOST_LEADS_DB" : "ALIGNED",
      rtt_max_ms: Math.max(...results.map((s) => s.rtt_ms)),
      same_instant_example: {
        db_clock_text: results[results.length - 1]!.db_clock_text,
        host_iso_at_same_instant: new Date(
          results[results.length - 1]!.db_ms,
        ).toISOString(),
      },
    };
    console.log(JSON.stringify({ summary }));
  } finally {
    await db.destroy();
    await pg?.stop();
  }
}

main().then(
  () => process.exit(0),
  (cause) => { console.error("PROBE_FAILED", cause); process.exit(1); },
);
