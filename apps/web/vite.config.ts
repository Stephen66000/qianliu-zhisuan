import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/*
 * W18：dev 同源代理到 control-api（默认 127.0.0.1:8788）。
 * 会话 cookie 为 SameSite=Lax，代理成同源后 fetch 才能带 cookie；
 * 目标地址可用 CONTROL_API_ORIGIN 覆盖。
 *
 * 关键（W20 E2E 修复）：proxy 路径与前端页面路由同名（/usage /dashboard /principals…），
 * 不能全部代理，否则浏览器页面导航会拿到后端 JSON 而不是 React SPA。
 * 用 Sec-Fetch-Mode 区分：页面导航是 "navigate"（交给 Vite SPA fallback 到 index.html），
 * API fetch 是 "cors"/"same-origin"（代理到 control-api）。无此头的非 GET 也按 API 处理。
 */
const CONTROL_API_ORIGIN = process.env.CONTROL_API_ORIGIN ?? "http://127.0.0.1:8788";

const PROXY_PATHS = [
  "/auth",
  "/dashboard",
  "/usage",
  "/principals",
  "/provider-resources",
  "/providers",
  "/unified-models",
  "/model-routes",
  "/grants",
  "/alerts",
  "/operation-logs",
  "/gateway-requests",
  "/billing-rules",
  "/dispatch-policies",
  "/supply-forecasts",
  "/health",
] as const;

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: "127.0.0.1",
    proxy: Object.fromEntries(
      PROXY_PATHS.map((path) => [
        path,
        {
          target: CONTROL_API_ORIGIN,
          changeOrigin: true,
          // 页面导航（Sec-Fetch-Mode: navigate）→ 交给 Vite SPA fallback（index.html）；
          // API fetch（cors/same-origin/无头）→ 代理到 control-api。
          bypass(req) {
            if (req.headers["sec-fetch-mode"] === "navigate") {
              return "/index.html";
            }
            return undefined;
          },
        },
      ]),
    ),
  },
  build: {
    outDir: "dist",
    sourcemap: true,
  },
});
