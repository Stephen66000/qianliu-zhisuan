/**
 * W18 预计最早耗尽 —— 核心区内容（仪表盘补充 §2：首页核心区应是"当下最需要关注的"）。
 *
 * 字体三级收敛（§4）：最重 = 资源名 15/22 600；次重 = 耗尽/恢复时间 13/20 深灰；
 * 最轻 = 厂商/可信度 12/18 浅灰。
 * 颜色纪律：提前耗尽是"需要人处理"的信号 → warning；不可计算按 PRD §10.4 展示原因，不给伪精确日期。
 */
import { TriangleAlert } from "lucide-react";

import type { EarliestExhaustion } from "../../api/types";
import { formatDateTimeShort } from "../../lib/format";
import { StatusTag } from "./StatusTag";

const CONFIDENCE_LABEL: Record<string, string> = {
  HIGH: "可信度高",
  MEDIUM: "可信度中",
  LOW: "可信度低",
};

interface EarliestExhaustionCardProps {
  value: EarliestExhaustion;
}

export function EarliestExhaustionCard({ value }: EarliestExhaustionCardProps) {
  return (
    <div className="rounded-xl border border-ql-border bg-ql-surface p-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          {/* 最重：内容主体名 15/22 600 */}
          <p className="text-[15px] font-semibold leading-[22px] text-ql-fg">{value.resourceName}</p>
          {/* 次重：关键一句 13/20 深灰 */}
          {value.forecastExhaustAt ? (
            <p className="mt-1 text-[13px] leading-5 text-ql-fg-secondary">
              预计 {formatDateTimeShort(value.forecastExhaustAt)} 耗尽
              {value.nextRecoverAt ? `，${formatDateTimeShort(value.nextRecoverAt)} 恢复` : ""}
            </p>
          ) : (
            <p className="mt-1 text-[13px] leading-5 text-ql-fg-secondary">
              {value.notCalculableReason ?? "数据不足，暂不可计算"}
            </p>
          )}
          {/* 最轻：元信息 12/18 浅灰 */}
          <p className="mt-1 text-[12px] leading-[18px] text-ql-fg-tertiary">
            {value.providerCode} · {CONFIDENCE_LABEL[value.confidence] ?? value.confidence}
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          <TriangleAlert aria-hidden className="h-4 w-4 text-ql-warning" />
          <StatusTag tone="warning">需关注</StatusTag>
        </div>
      </div>
    </div>
  );
}
