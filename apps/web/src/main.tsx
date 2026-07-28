/**
 * W18 前端入口 —— 主题防闪烁由 index.html 内联脚本完成；
 * 这里挂载 QueryClient + 路由（七入口，TRD §11.1）。
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { App } from "./App";
import "./styles/tokens.css";
import "./styles/index.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // 无界重试禁止（工程规则 §7）；401 不重试（会话失效重试无意义）
      retry: (failureCount, error) => {
        if (error instanceof Error && error.name === "UnauthorizedError") {
          return false;
        }
        return failureCount < 1;
      },
      refetchOnWindowFocus: false,
    },
  },
});

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("未找到 #root 挂载点");
}

createRoot(rootElement).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
