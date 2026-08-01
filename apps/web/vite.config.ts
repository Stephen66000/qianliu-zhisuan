import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/*
 * W18：dev 同源代理到 control-api（默认 127.0.0.1:8788）。
 * 会话 cookie 为 SameSite=Lax，代理成同源后 fetch 才能带 cookie；
 * 目标地址可用 CONTROL_API_ORIGIN 覆盖。
 *
 * 前端所有 API 请求统一加 /api 前缀（见 api/client.ts）；代理时 rewrite 去掉 /api。
 * 这样 dev/prod 都能用同一规则区分 API（/api/*）与 SPA 页面路由（其余）。
 */
const CONTROL_API_ORIGIN = process.env.CONTROL_API_ORIGIN
  ?? (process.env.E2E_CONTROL_API_PORT
    ? `http://127.0.0.1:${process.env.E2E_CONTROL_API_PORT}`
    : "http://127.0.0.1:8788");

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: "127.0.0.1",
    proxy: {
      "/api": {
        target: CONTROL_API_ORIGIN,
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api/, ""),
      },
    },
  },
  build: {
    outDir: "dist",
    // 生产包不发布源码映射；需要排障时在受控构建中临时开启并单独保管。
    sourcemap: false,
  },
});
