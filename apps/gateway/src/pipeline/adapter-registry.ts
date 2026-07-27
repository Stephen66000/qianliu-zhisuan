/**
 * Adapter 注册表（W09）。
 *
 * 解除 real-pipeline 对单一 Adapter / providerCode="deepseek" 的硬编码。
 * Gateway 在请求时按资源查出的 providerCode 选择对应 Adapter。
 *
 * M3 阶段（W09）：注册表以注入的 UpstreamCaller（StubUpstream）构造各厂商 Adapter。
 * 真实 HTTP fetch（DeepSeek/Zhipu/Kimi）在 DEP-PROVIDER-CREDENTIALS 解锁后，
 * 把对应 caller 替换为真实实现即可，注册表结构不变。
 *
 * 依据：TRD §7（Adapter 统一能力）、§7.1/§7.2/§7.3（各厂商差异在 Adapter 内隔离）。
 */
import {
  DeepSeekAdapter,
  ZhipuAdapter,
  KimiAdapter,
  type ProviderAdapter,
  type UpstreamCaller,
} from "@qianliu/provider-adapters";

export type ProviderCode = "deepseek" | "zhipu" | "kimi";

/**
 * 按厂商 code 解析 Adapter。未注册的 code 抛错（避免静默选错 Adapter）。
 * Kimi 于 W10 落地并注册。
 */
export function resolveAdapter(
  providerCode: string,
  caller: UpstreamCaller,
): ProviderAdapter {
  switch (providerCode) {
    case "deepseek":
      return new DeepSeekAdapter(caller);
    case "zhipu":
      return new ZhipuAdapter(caller);
    case "kimi":
      return new KimiAdapter(caller);
    default:
      throw new Error(`unsupported_provider_code: ${providerCode}`);
  }
}
