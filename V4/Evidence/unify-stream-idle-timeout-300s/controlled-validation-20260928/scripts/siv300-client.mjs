/**
 * 受控链路客户端（tasks 6.3）——HTTP 客户端 → 可控代理(58080) → 候选 Gateway 容器(58787) → 慢上游(9399)。
 *
 * T1 加速 Responses(stream=true)：完整 Responses SSE 成功路径（协议/配置证明）。
 * T2 加速 Responses(stream=false)：完整 Responses JSON 成功路径。
 * T3 失败路径：上游 401 → 北向错误合同（记录实际结构断言 code/request_id）。
 * T4 真实时间慢聚合：上游每 10 秒发数据、约 335 秒完成；断言连接保持 ≥330 秒且返回完整 Responses SSE。
 *
 * 全部经代理走真实链路；仅回环与隔离容器，不触生产。
 */
import { request as httpRequest } from "node:http";
import { readFileSync } from "node:fs";

const PROXY_HOST = "127.0.0.1";
const PROXY_PORT = 58080;
const keyFile = new URL("../logs/api-key.txt", import.meta.url).pathname;
const API_KEY = readFileSync(decodeURIComponent(keyFile), "utf8").split("\n")[0].trim();

const results = [];
function record(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"} ${name} :: ${detail}`);
  if (!pass) process.exitCode = 1;
}

function post(path, bodyObj) {
  const body = JSON.stringify(bodyObj);
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      host: PROXY_HOST, port: PROXY_PORT, path, method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${API_KEY}`,
        "content-length": Buffer.byteLength(body),
      },
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({
        status: res.statusCode,
        headers: res.headers,
        text: Buffer.concat(chunks).toString("utf8"),
        elapsedMs: Date.now() - startedAt,
      }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

function parseSseEvents(text) {
  return text.split("\n\n").filter((b) => b.startsWith("event: ")).map((b) => {
    const lines = b.split("\n");
    const type = lines[0].slice("event: ".length);
    const data = JSON.parse(lines.find((l) => l.startsWith("data: "))?.slice("data: ".length) ?? "{}");
    return { type, data };
  });
}

const MODEL = "siv300-model";
const SLOW_MODEL = "siv300-slow";
const ERROR_MODEL = "siv300-error";
// 阶段选择：node siv300-client.mjs T1,T2 —— 只跑指定阶段（T3 的上游 401 会将共享
// 资源标记不健康，故 T3 与 T4 分开执行并各自重置健康态）。
const PHASES = new Set((process.argv[2] ?? "T1,T2,T3,T4").split(","));

// T1 加速流式 Responses：完整 Responses SSE。
if (PHASES.has("T1")) {
  const res = await post("/v1/responses", { model: MODEL, input: "hi", stream: true });
  const events = parseSseEvents(res.text);
  const completed = events.find((e) => e.type === "response.completed");
  const ok = res.status === 200
    && res.headers["content-type"]?.includes("text/event-stream")
    && Boolean(completed)
    && completed.data.response?.status === "completed"
    && Boolean(completed.data.response?.usage);
  record("T1 加速 Responses SSE 成功路径", Boolean(ok),
    `status=${res.status} ct=${res.headers["content-type"]} events=${events.map((e) => e.type).join(",")} elapsed=${(res.elapsedMs / 1000).toFixed(1)}s usage=${JSON.stringify(completed?.data.response?.usage ?? null)}`);
}

// T2 加速非流式 Responses：完整 JSON。
if (PHASES.has("T2")) {
  const res = await post("/v1/responses", { model: MODEL, input: "hi", stream: false });
  let ok = false; let detail = `status=${res.status}`;
  try {
    const json = JSON.parse(res.text);
    ok = res.status === 200 && json.status === "completed" && Boolean(json.usage) && Array.isArray(json.output);
    detail += ` id=${json.id} status=${json.status} usage=${JSON.stringify(json.usage ?? null)}`;
  } catch (e) { detail += ` parse_error=${e.message} body=${res.text.slice(0, 200)}`; }
  record("T2 加速 Responses JSON 成功路径", ok, detail);
}

// T3 失败路径：上游 401 → 北向错误合同。
if (PHASES.has("T3")) {
  const res = await post("/v1/responses", { model: ERROR_MODEL, input: "hi", stream: false });
  let ok = false; let detail = `status=${res.status}`;
  try {
    const json = JSON.parse(res.text);
    const err = json.error ?? {};
    ok = res.status >= 400 && res.status < 500 || res.status >= 500;
    ok = Boolean(err.code) && Boolean(err.request_id) && Boolean(err.message);
    detail += ` code=${err.code} type=${err.type} request_id=${err.request_id ? "present" : "MISSING"} failure_layer=${err.failure_layer ?? "n/a"} message=${JSON.stringify(err.message ?? null)}`;
  } catch (e) { detail += ` parse_error=${e.message} body=${res.text.slice(0, 200)}`; }
  record("T3 失败路径错误合同", ok, detail);
}

// T4 真实时间慢聚合（约 335 秒，>330 秒门槛）。
if (PHASES.has("T4")) {
  console.log(`[client] T4 start ${new Date().toISOString()}`);
  const res = await post("/v1/responses", { model: SLOW_MODEL, input: "慢聚合", stream: true });
  const elapsedSec = res.elapsedMs / 1000;
  const events = parseSseEvents(res.text);
  const completed = events.find((e) => e.type === "response.completed");
  const ok = res.status === 200
    && elapsedSec >= 330
    && elapsedSec < 420
    && Boolean(completed)
    && completed.data.response?.status === "completed";
  record("T4 Responses 慢聚合 >330s 连接保持", ok,
    `status=${res.status} elapsed=${elapsedSec.toFixed(1)}s events=${events.length} completed=${Boolean(completed)} usage=${JSON.stringify(completed?.data.response?.usage ?? null)}`);
}

const failed = results.filter((r) => !r.pass);
console.log(`SUMMARY total=${results.length} pass=${results.length - failed.length} fail=${failed.length}`);
process.exit(failed.length > 0 ? 1 : 0);
