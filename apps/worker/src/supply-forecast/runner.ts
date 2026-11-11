import { readProviderOperatingBalanceExpireMs } from "@qianliu/config";
import type { SupplyForecastRepository, SupplyForecastTickResult } from "@qianliu/database";

export async function runSupplyForecastTick(
  repository: SupplyForecastRepository,
  now: Date = new Date(),
): Promise<SupplyForecastTickResult> {
  // WP3/OAB-07：P2 官方余额过期阈值由配置注入（repo 缺省仅镜像冻结默认值）。
  return repository.runTick(now, 60_000, readProviderOperatingBalanceExpireMs(process.env));
}
