/**
 * W18 异常告警 —— 页面壳 + 空状态（PRD §10.4：显示"运行正常"，保留查看历史事件入口）。
 * 告警看板与处理闭环在 W20 落地。
 */
import { ShieldCheck } from "lucide-react";

import { PageShell } from "../components/layout/PageShell";
import { EmptyState } from "../components/states/EmptyState";

export function AlertsPage() {
  return (
    <PageShell description="资源可用性与额度/费用异常信号" title="异常告警">
      <EmptyState
        description="当前没有未处理告警。告警看板与历史事件查看将在后续版本（W20）开放。"
        icon={ShieldCheck}
        title="运行正常"
      />
    </PageShell>
  );
}
