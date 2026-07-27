import { createRoot } from "react-dom/client";

/**
 * @qianliu/web —— 桌面管理 Web。
 * W01 仅提供可启动的占位根组件。M1 的资源/主体/Key/额度页面在 W18-W23 落地。
 */
function App(): React.JSX.Element {
  return (
    <div style={{ fontFamily: "system-ui, sans-serif", padding: "2rem" }}>
      <h1>仟流智算</h1>
      <p>W01 基线骨架。管理 Web 页面在 M1-W18 起逐步落地。</p>
    </div>
  );
}

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("#root not found");
createRoot(rootEl).render(<App />);
