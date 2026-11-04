/**
 * X08 在途请求轮询器（证据脚本）：轻量等待指定企业出现 IN_PROGRESS 的
 * ai_request 并输出其 request id（纯 pg 客户端，秒级返回，避免错过
 * mock 延迟窗口）。超时未出现则以非零码退出。
 *
 * 运行：DATABASE_URL=... node x08-poll.mjs [timeout_seconds]
 */
import pgClient from "/Users/mac/Projects/仟流智算-api-decouple/packages/database/node_modules/pg/lib/index.js";

const timeoutSeconds = Number(process.argv[2] ?? 12);
const deadline = Date.now() + timeoutSeconds * 1000;
const client = new pgClient.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
try {
  while (Date.now() < deadline) {
    const result = await client.query(
      "SELECT id::text AS id FROM ai_request WHERE enterprise_id=$1::uuid AND status='IN_PROGRESS'"
      + " ORDER BY started_at DESC LIMIT 1",
      [process.env.X08_ENTERPRISE_ID],
    );
    if (result.rows.length > 0) {
      console.log(result.rows[0].id);
      process.exit(0);
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  console.error("X08_POLL_TIMEOUT 未出现 IN_PROGRESS 请求");
  process.exit(1);
} finally {
  await client.end();
}
