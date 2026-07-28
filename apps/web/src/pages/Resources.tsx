/**
 * W18 厂商资源 —— 页面壳 + 空状态（PRD §10.4）。
 * 资源登记写操作在 W19 落地。
 */
import { Server } from "lucide-react";

import { PageShell } from "../components/layout/PageShell";
import { EmptyState } from "../components/states/EmptyState";

export function ResourcesPage() {
  return (
    <PageShell description="厂商 API 与套餐资源的登记与状态" title="厂商资源">
      <EmptyState
        description="尚未登记可用 AI 资源，无法产生模型和路由候选。资源登记将在下一版本（W19）开放，届时可登记 DeepSeek API、智谱或 Kimi 资源。"
        icon={Server}
        title="尚未登记厂商资源"
      />
    </PageShell>
  );
}
