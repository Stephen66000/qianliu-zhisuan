/**
 * 受控慢上游（tasks 6.3 受控验证）——仅回环，绑定 127.0.0.1:9399。
 * 候选 Gateway 容器经 host.docker.internal 访问本进程。
 *
 * 模式由请求体 model 选择（与 model_route.upstream_model 对应）：
 *   deepseek-fast  —— 立即返回：流式请求回完整 SSE（含 usage + [DONE]）；非流式回完整 JSON。
 *   deepseek-slow  —— 真实时间慢流：流式每 10 秒发一个非空 delta（模拟上游持续有数据），
 *                     约 335 秒后发 usage 终帧 + [DONE]；非流式每 10 秒滴注 JSON 片段，
 *                     约 335 秒后收尾。用于验证下游聚合等待 >330 秒连接保持。
 *   deepseek-error —— 立即 401 JSON（失败路径错误合同验证）。
 */
import { createServer } from "node:http";

const PORT = 9399;
const SLOW_SECONDS = 335;
const CHUNK_EVERY_MS = 10_000;

const USAGE = {
  prompt_tokens: 12, completion_tokens: 8, total_tokens: 20,
  prompt_cache_hit_tokens: 0,
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

const server = createServer(async (req, res) => {
  const raw = await readBody(req);
  let model = "unknown";
  let stream = false;
  try {
    const body = JSON.parse(raw);
    model = String(body.model ?? "unknown");
    stream = body.stream === true;
  } catch { /* 忽略解析失败，按 unknown 处理 */ }
  console.log(`[upstream] ${new Date().toISOString()} model=${model} stream=${stream}`);

  if (model === "deepseek-error") {
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "Invalid API key", type: "invalid_request_error", code: "invalid_api_key" } }));
    return;
  }

  if (model === "deepseek-slow") {
    const startedAt = Date.now();
    if (stream) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "慢流首块" } }] })}\n\n`);
      const timer = setInterval(() => {
        const elapsed = (Date.now() - startedAt) / 1000;
        if (elapsed >= SLOW_SECONDS) {
          clearInterval(timer);
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "终块" }, finish_reason: "stop" }], usage: USAGE })}\n\n`);
          res.write("data: [DONE]\n\n");
          res.end();
          console.log(`[upstream] slow stream completed at ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
          return;
        }
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: `慢流块@${elapsed.toFixed(0)}s` } }] })}\n\n`);
        console.log(`[upstream] slow chunk @${elapsed.toFixed(0)}s`);
      }, CHUNK_EVERY_MS);
      req.on("close", () => clearInterval(timer));
    } else {
      res.writeHead(200, { "content-type": "application/json" });
      res.write('{"choices":[{"message":{"role":"assistant","content":"');
      const timer = setInterval(() => {
        const elapsed = (Date.now() - startedAt) / 1000;
        if (elapsed >= SLOW_SECONDS) {
          clearInterval(timer);
          res.write(`慢流聚合完成"},"finish_reason":"stop"}],"usage":${JSON.stringify(USAGE)}}`);
          res.end();
          console.log(`[upstream] slow json completed at ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
          return;
        }
        res.write(`慢流片段@${elapsed.toFixed(0)}s；`);
        console.log(`[upstream] slow json drip @${elapsed.toFixed(0)}s`);
      }, CHUNK_EVERY_MS);
      req.on("close", () => clearInterval(timer));
    }
    return;
  }

  // deepseek-fast 及默认：立即成功。
  if (stream) {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "加速成功" } }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "终块" }, finish_reason: "stop" }], usage: USAGE })}\n\n`);
    res.write("data: [DONE]\n\n");
    res.end();
  } else {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      choices: [{ message: { role: "assistant", content: "加速成功" }, finish_reason: "stop" }],
      usage: USAGE,
    }));
  }
});

server.requestTimeout = 0;
server.headersTimeout = 700_000;
server.listen(PORT, "127.0.0.1", () => {
  console.log(`[upstream] controlled slow upstream listening on 127.0.0.1:${PORT} (slow=${SLOW_SECONDS}s)`);
});
