/**
 * 可控反向代理（tasks 6.3 受控验证）——仅回环。
 * 客户端 → 127.0.0.1:58080 → 候选 Gateway 127.0.0.1:58787。
 *
 * 6.3 要求：/v1/* 入口等待配置覆盖 600 秒总时限及至少 60 秒发送余量（≥660 秒）。
 * 本代理把全部相关等待显式配置为 660 秒或关闭（0=不限），并在启动时打印生效值作为证据。
 */
import { createServer, request as httpRequest } from "node:http";

const PORT = 58080;
const TARGET = "http://127.0.0.1:58787";
const WAIT_MS = 660_000; // 600 秒总时限 + 60 秒余量

const server = createServer((clientReq, clientRes) => {
  const startedAt = Date.now();
  const upstreamReq = httpRequest(
    `${TARGET}${clientReq.url}`,
    { method: clientReq.method, headers: clientReq.headers },
    (upstreamRes) => {
      clientRes.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
      upstreamRes.pipe(clientRes);
      upstreamRes.on("end", () => {
        console.log(`[proxy] ${clientReq.url} completed in ${((Date.now() - startedAt) / 1000).toFixed(1)}s status=${upstreamRes.statusCode}`);
      });
    },
  );
  upstreamReq.setTimeout(WAIT_MS + 60_000); // 出站 socket 空闲上限 720s，仅兜底
  upstreamReq.on("timeout", () => upstreamReq.destroy(new Error("proxy_upstream_wait_exceeded")));
  clientReq.pipe(upstreamReq);
  clientReq.on("error", () => upstreamReq.destroy());
});

// 入站等待配置（证据：与部署文档 §要求一致，≥660 秒）。
server.requestTimeout = 0;            // 关闭整个请求接收时限（Node 默认 300s，必须显式关闭）
server.headersTimeout = WAIT_MS;      // 660s
server.keepAliveTimeout = WAIT_MS;    // 660s
server.timeout = 0;                   // 关闭 socket 空闲时限（响应聚合期间无数据是预期行为）

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[proxy] listening on 127.0.0.1:${PORT} -> ${TARGET}`);
  console.log(`[proxy] effective waits: requestTimeout=${server.requestTimeout} headersTimeout=${server.headersTimeout} keepAliveTimeout=${server.keepAliveTimeout} timeout=${server.timeout} upstreamSocketIdle=${WAIT_MS + 60_000} (all >= 660s or disabled)`);
});
