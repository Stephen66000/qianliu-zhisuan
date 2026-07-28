/**
 * W18 系统设置 —— 页面壳（一期仅主题偏好已在顶栏提供；企业级设置项后续版本开放）。
 */
import { Settings } from "lucide-react";

import { PageShell } from "../components/layout/PageShell";
import { EmptyState } from "../components/states/EmptyState";

export function SettingsPage() {
  return (
    <PageShell description="企业与平台级配置" title="系统设置">
      <EmptyState
        description="一期暂无可配置项。主题偏好可在页面顶栏切换（跟随系统 / 浅色 / 深色）。"
        icon={Settings}
        title="暂无设置项"
      />
    </PageShell>
  );
}
