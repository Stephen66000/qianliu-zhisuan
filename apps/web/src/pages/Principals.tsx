/**
 * W18 使用主体 —— 页面壳 + 空状态（PRD §10.4）。
 * 写操作（创建员工/项目、四步开通）在 W19 落地。
 */
import { Users } from "lucide-react";

import { PageShell } from "../components/layout/PageShell";
import { EmptyState } from "../components/states/EmptyState";

export function PrincipalsPage() {
  return (
    <PageShell description="员工与项目的统一主体管理" title="使用主体">
      <EmptyState
        description="尚未创建使用主体，也未生成主体 Key。主体创建与四步开通将在下一版本（W19）开放。"
        icon={Users}
        title="尚未创建使用主体"
      />
    </PageShell>
  );
}
