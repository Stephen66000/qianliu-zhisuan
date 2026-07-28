/**
 * W18 额度规则 —— 页面壳 + 空状态（PRD §10.4）。
 * 规则创建写操作在 W19 落地。
 */
import { Gauge } from "lucide-react";

import { PageShell } from "../components/layout/PageShell";
import { EmptyState } from "../components/states/EmptyState";

export function QuotaRulesPage() {
  return (
    <PageShell description="主体额度分配与扣减规则" title="额度规则">
      <EmptyState
        description="尚未配置额度规则。规则配置将在下一版本（W19）开放；配置前主体调用不受额度约束。"
        icon={Gauge}
        title="尚未配置额度规则"
      />
    </PageShell>
  );
}
