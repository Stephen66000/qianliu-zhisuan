/**
 * X08 切换演练本地模拟上游（证据脚本，node:http 实现，无外部依赖）。
 *
 * 端口：X08_MOCK_PORT（默认 19191，走查遗留 5173/8788 占用回避段）。
 * 端点：
 *   POST /v1/chat/completions —— OpenAI 兼容非流式响应；usage 由首条消息内容
 *     标记决定（确定性金额）；标记 X08-T1-INFLIGHT 附加 8000ms 延迟（在途收尾时序）。
 *   GET  /user/balance —— DeepSeek 官方余额合同（is_available + balance_infos），
 *     total_balance 固定 "110.50"（刷新成功值可断言）。
 *   GET  /__x08/stats —— 调用计数（chat/balance/models/total + 最近请求行）。
 *
 * 所有计数仅内存保存；每次调用同步落盘 X08_MOCK_STATS_PATH（若设置），
 * 供编排脚本在任意时点读取（断言 E）。
 */
import { createServer } from "node:http";
import { writeFileSync } from "node:fs";

const PORT = Number(process.env.X08_MOCK_PORT ?? 19191);
const HOST = "127.0.0.1";
const statsPath = process.env.X08_MOCK_STATS_PATH ?? "";

const USAGE_BY_MARKER = {
  "X08-T0-NORMAL": { prompt_tokens: 1000, completion_tokens: 200 },
  "X08-T1-INFLIGHT": { prompt_tokens: 400, completion_tokens: 100, delayMs: 8000 },
  "X08-T4-NEW": { prompt_tokens: 600, completion_tokens: 150 },
};
const DEFAULT_USAGE = { prompt_tokens: 10, completion_tokens: 5 };

const stats = { chat: 0, balance: 0, models: 0, other: 0, total: 0, recent: [] };

function persistStats() {
  if (!statsPath) return;
  try {
    writeFileSync(statsPath, `${JSON.stringify({ ...stats, updatedAt: new Date().toISOString() })}\n`);
  } catch {
    // 计数落盘失败不中断模拟上游本身。
  }
}

function readBody(request) {
  return new Promise((resolve) => {
    let raw = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      raw += chunk;
    });
    request.on("end", () => resolve(raw));
  });
}

const server = createServer((request, response) => {
  const startedAt = new Date().toISOString();
  const finish = (status, payload) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(payload));
  };
  const route = `${request.method} ${new URL(request.url, `http://${HOST}:${PORT}`).pathname}`;
  stats.total += 1;
  if (route === "POST /v1/chat/completions") {
    stats.chat += 1;
    void readBody(request).then((raw) => {
      let content = "";
      try {
        const body = JSON.parse(raw);
        const last = body.messages ? body.messages[body.messages.length - 1] : null;
        content = typeof last?.content === "string" ? last.content : "";
      } catch {
        content = "";
      }
      const marker = Object.keys(USAGE_BY_MARKER).find((key) => content.includes(key)) ?? null;
      const usage = marker ? USAGE_BY_MARKER[marker] : DEFAULT_USAGE;
      const delayMs = marker === "X08-T1-INFLIGHT" ? 4000 : 0;
      stats.recent.push({ ts: startedAt, route, marker, delayMs });
      if (stats.recent.length > 200) stats.recent.shift();
      persistStats();
      setTimeout(() => {
        finish(200, {
          id: `chatcmpl-x08-${stats.chat}`,
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: "deepseek-chat",
          choices: [{
            index: 0,
            message: { role: "assistant", content: `X08 模拟上游响应（${marker ?? "default"}）` },
            finish_reason: "stop",
          }],
          usage: {
            prompt_tokens: usage.prompt_tokens,
            completion_tokens: usage.completion_tokens,
            prompt_tokens_details: { cached_tokens: 0 },
            completion_tokens_details: { reasoning_tokens: 0 },
            total_tokens: usage.prompt_tokens + usage.completion_tokens,
          },
        });
      }, delayMs);
    });
    return;
  }
  if (route === "GET /user/balance") {
    stats.balance += 1;
    stats.recent.push({ ts: startedAt, route, marker: null, delayMs: 0 });
    if (stats.recent.length > 200) stats.recent.shift();
    persistStats();
    finish(200, {
      is_available: true,
      balance_infos: [{
        currency: "CNY", total_balance: "110.50",
        granted_balance: "10.50", topped_up_balance: "100.00",
      }],
    });
    return;
  }
  if (route === "GET /__x08/stats") {
    finish(200, { ...stats, updatedAt: new Date().toISOString() });
    return;
  }
  stats.other += 1;
  stats.recent.push({ ts: startedAt, route, marker: null, delayMs: 0 });
  persistStats();
  finish(404, { error: "not_found", route });
});

server.listen(PORT, HOST, () => {
  process.stdout.write(`${JSON.stringify({ event: "x08_mock_upstream_listening", host: HOST, port: PORT })}\n`);
});

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.once(signal, () => {
    persistStats();
    server.close(() => process.exit(0));
  });
}
