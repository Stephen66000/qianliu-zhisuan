/**
 * X08 切换演练 fetch 守卫（证据脚本，非业务代码；经 NODE_OPTIONS="--import 本文件"
 * 注入 control-api / gateway / worker 进程）。
 *
 * 背景：官方余额适配器硬编码 https://api.deepseek.com/user/balance
 * （packages/provider-adapters/src/provider-operating-facts.ts:30，两栈同码），
 * 多进程演练要求所有上游流量只允许指向本地模拟上游。本守卫在 fetch 层：
 *   - 127.0.0.1/localhost/[::1]：放行（本地 mock、本地服务间调用）；
 *   - api.deepseek.com：改写到 X08_MOCK_ORIGIN（同一 path/query），记 redirected；
 *   - 其余一切主机：BLOCKED——抛错且不发起任何真实外呼（fail-closed）。
 * 每次调用追加一行 JSONL 到 X08_FETCH_GUARD_LOG（断言 E 的网络层证据）。
 */
import { appendFileSync } from "node:fs";

const logPath = process.env.X08_FETCH_GUARD_LOG ?? "";
const mockOrigin = process.env.X08_MOCK_ORIGIN ?? "http://127.0.0.1:19191";
const service = process.env.X08_SERVICE ?? "unknown";
const originalFetch = globalThis.fetch;

function urlOf(input) {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  if (input && typeof input.url === "string") return input.url;
  return null;
}

function log(entry) {
  if (!logPath) return;
  try {
    appendFileSync(logPath, `${JSON.stringify({ service, pid: process.pid, ...entry })}\n`);
  } catch {
    // 守卫日志失败不得影响业务调用本身。
  }
}

globalThis.fetch = async function x08GuardedFetch(input, init) {
  const rawUrl = urlOf(input);
  if (rawUrl === null) {
    log({ ts: new Date().toISOString(), action: "PASS_UNPARSEABLE", originalUrl: String(input) });
    return originalFetch(input, init);
  }
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    log({ ts: new Date().toISOString(), action: "PASS_UNPARSEABLE", originalUrl: rawUrl });
    return originalFetch(input, init);
  }
  const local = ["127.0.0.1", "localhost", "[::1]", "::1"].includes(parsed.hostname);
  if (local) {
    log({ ts: new Date().toISOString(), action: "pass", originalUrl: rawUrl, finalUrl: rawUrl });
    return originalFetch(input, init);
  }
  if (parsed.hostname === "api.deepseek.com") {
    const finalUrl = mockOrigin + parsed.pathname + parsed.search;
    log({ ts: new Date().toISOString(), action: "redirected_to_mock", originalUrl: rawUrl, finalUrl });
    if (typeof input === "string" || input instanceof URL) {
      return originalFetch(new URL(finalUrl), init);
    }
    // Request 对象：以新 URL 克隆，其余属性原样保留。
    return originalFetch(new Request(finalUrl, input), init);
  }
  log({ ts: new Date().toISOString(), action: "BLOCKED", originalUrl: rawUrl });
  throw new Error(`X08 fetch guard BLOCKED non-local upstream call: ${rawUrl}`);
};
