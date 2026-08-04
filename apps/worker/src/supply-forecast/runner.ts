import type { SupplyForecastRepository, SupplyForecastTickResult } from "@qianliu/database";

export async function runSupplyForecastTick(
  repository: SupplyForecastRepository,
  now: Date = new Date(),
): Promise<SupplyForecastTickResult> {
  return repository.runTick(now);
}
