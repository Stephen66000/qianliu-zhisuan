/**
 * 持续供给预测 Worker 的单次触发入口。
 * 预测公式、幂等与落库均由 Repository 统一维护，Worker 不复制业务算法。
 */
import type { SupplyForecastRepository, SupplyForecastTickResult } from "@qianliu/database";

export async function runSupplyForecastTick(
  repository: SupplyForecastRepository,
  now: Date = new Date(),
): Promise<SupplyForecastTickResult> {
  return repository.runTick(now);
}
