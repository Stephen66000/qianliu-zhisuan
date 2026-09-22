/**
 * 项目归集补偿扫描 tick 的 worker 包装（80 终审 P1-3 拆分自 main.ts）：
 * 结果与失败都以结构化日志输出，不中断主循环。
 */
import { projectAllocationTick } from "@qianliu/database";

export async function runProjectAllocationTickSafely(
  db: Parameters<typeof projectAllocationTick>[0],
  workerId: string,
): Promise<void> {
  try {
    const allocation = await projectAllocationTick(db, workerId);
    // eslint-disable-next-line no-console -- worker 结构化日志约定（与 main.ts 一致）
    console.log(JSON.stringify({ event: "project_allocation_tick_completed", ...allocation }));
  } catch (error) {
    console.error(JSON.stringify({
      event: "project_allocation_tick_failed",
      error_type: error instanceof Error ? error.name : typeof error,
      message: error instanceof Error ? error.message : String(error),
    }));
  }
}
