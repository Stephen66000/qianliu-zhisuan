/**
 * W18 空状态 —— 按 PRD §10.4：必须说明"为什么为空、下一步做什么"，
 * 不能用空白表格冒充正常页面。
 *
 * 视觉：Web 规范 §10 空状态；语义图标用双色调规则（蓝描边+浅蓝填充，每图标最多一个青点，
 * 视觉法则 1.2 §icon）—— 此处用 Lucide 单色线性 + surface-brand-soft 底（icon box）。
 */
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

interface EmptyStateProps {
  icon: LucideIcon;
  /** 空状态主张（一句话说明为什么为空）。 */
  title: string;
  /** 补充说明（可选）。 */
  description?: string;
  /** 引导动作（"去登记"链接/按钮，可选，W19 写操作落地后激活）。 */
  action?: ReactNode;
}

export function EmptyState({ icon: Icon, title, description, action }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center gap-3 py-12 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-ql-surface-brand-soft">
        <Icon aria-hidden className="h-6 w-6 text-ql-action" />
      </div>
      <p className="text-[14px] font-medium leading-[22px] text-ql-fg">{title}</p>
      {description ? (
        <p className="max-w-md text-[13px] leading-5 text-ql-fg-secondary">{description}</p>
      ) : null}
      {action}
    </div>
  );
}
