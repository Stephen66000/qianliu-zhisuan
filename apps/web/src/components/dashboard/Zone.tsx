/**
 * W18 仪表盘区域容器 —— 仪表盘补充 §1-2：Canvas 与 Card 之间的 Zone 层。
 *
 * Zone 参数：白底 / 圆角 16px / 边框 ql-border-zone（比内卡浅一档）/
 * 内边距 16px（核心区 20px）/ 容器间距 20px（由父级 gap-5 提供）/
 * 区域标题收进容器内左上角 16px 600。
 * 核心区（一页最多一个）：边框正常深度 + ql-shadow-zone-focus + 内边距 20px。
 */
import type { ReactNode } from "react";

interface ZoneProps {
  title: string;
  /** 副说明（12px 灰）。 */
  description?: string;
  /** 核心区：一页最多一个。 */
  focus?: boolean;
  children: ReactNode;
}

export function Zone({ title, description, focus = false, children }: ZoneProps) {
  return (
    <section
      className={[
        "rounded-2xl border bg-ql-surface",
        focus ? "border-ql-border p-5 shadow-ql-zone-focus" : "border-ql-border-zone p-4",
      ].join(" ")}
    >
      <header className="mb-3">
        <h2 className="text-[16px] font-semibold leading-6 text-ql-fg">{title}</h2>
        {description ? (
          <p className="mt-0.5 text-[12px] leading-[18px] text-ql-fg-tertiary">{description}</p>
        ) : null}
      </header>
      {children}
    </section>
  );
}
