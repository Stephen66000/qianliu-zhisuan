import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/*
 * W18：dev 同源代理到 control-api（默认 127.0.0.1:8788）。
 * 会话 cookie 为 SameSite=Lax，代理成同源后 fetch 才能带 cookie；
 * 目标地址可用 CONTROL_API_ORIGIN 覆盖。
 */
const CONTROL_API_ORIGIN = process.env.CONTROL_API_ORIGIN ?? "http://127.0.0.1:8788";

const PROXY_PATHS = [
  "/auth",
  "/dashboard",
  "/usage",
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
      PROXY_PATHS.map((path) => [path, { target: CONTROL_API_ORIGIN, changeOrigin: true }]),
    ),
  },
  build: {
    outDir: "dist",
    sourcemap: true,
  },
});
