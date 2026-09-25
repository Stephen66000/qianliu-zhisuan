// WP08 本地 stub 上游（仅本机回环/容器私网；不转发任何真实厂商请求）。
// 职责：① 记录每一次入站调用（证明“零上游”）；② 返回最小可用的 OpenAI 兼容响应。
import { createServer } from "node:http";

const PORT = Number(process.env.STUB_PORT ?? 9299);
/** @type {{seq:number, method:string, url:string, at:string}[]} */
const hits = [];
let startedAt = new Date().toISOString();

const json = (res, code, body) => {
  const payload = JSON.stringify(body);
  res.writeHead(code, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) });
  res.end(payload);
};

const completion = (model) => ({
  id: `chatcmpl-wp08-stub-${hits.length}`,
  object: "chat.completion",
  created: Math.floor(Date.now() / 1000),
  model: model ?? "wp08-stub-model",
  choices: [{ index: 0, message: { role: "assistant", content: "wp08-stub-ok" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 },
});

const server = createServer((req, res) => {
  const url = req.url ?? "/";
  // 控制面端点不计数（避免观测行为本身污染“零上游”证据）。
  if (url.startsWith("/__stats")) {
    return json(res, 200, { startedAt, totalHits: hits.length, hits });
  }
  if (url.startsWith("/__reset")) {
    hits.length = 0;
    startedAt = new Date().toISOString();
    return json(res, 200, { reset: true });
  }
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    hits.push({ seq: hits.length + 1, method: req.method ?? "?", url, at: new Date().toISOString() });
    process.stdout.write(`[WP08-STUB-HIT] #${hits.length} ${req.method} ${url}\n`);
    if (url.includes("/chat/completions")) {
      const body = Buffer.concat(chunks).toString("utf8");
      let model;
      try {
        model = JSON.parse(body).model;
      } catch {
        model = undefined;
      }
      // 慢响应开关：模型名含 "slow" 时延迟应答，用于演练「在途请求不被静默门禁中止」。
      if (typeof model === "string" && model.includes("slow")) {
        const delay = Number(process.env.STUB_SLOW_MS ?? 8000);
        process.stdout.write(`[WP08-STUB-SLOW] model=${model} delay=${delay}ms\n`);
        setTimeout(() => json(res, 200, completion(model)), delay);
        return;
      }
      if (body.includes('"stream":true')) {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        const chunk = {
          id: "chatcmpl-wp08-stub-stream",
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: model ?? "wp08-stub-model",
          choices: [{ index: 0, delta: { role: "assistant", content: "wp08-stub-ok" }, finish_reason: null }],
        };
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        res.write(
          `data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
        );
        res.write("data: [DONE]\n\n");
        return res.end();
      }
      return json(res, 200, completion(model));
    }
    if (url.includes("/models")) {
      return json(res, 200, { object: "list", data: [{ id: "deepseek-chat", object: "model" }] });
    }
    return json(res, 404, { error: { message: `wp08 stub: 未支持 ${url}`, type: "not_found" } });
  });
});

server.listen(PORT, "0.0.0.0", () => {
  process.stdout.write(`[WP08-STUB] listening on :${PORT}\n`);
});
