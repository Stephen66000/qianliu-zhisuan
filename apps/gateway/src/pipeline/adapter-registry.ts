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
 * 按持久化的 adapter_type 解析 Adapter（与 control-api 创建厂商时写入的
 * provider.adapter_type 保持同一判定来源，不再各自按 code 猜测）。
 * 未知 adapter_type 回退 OpenAI 兼容（DeepSeekAdapter）并打 warn，
 * 避免静默选错 Adapter。
 */
export function resolveAdapter(
  adapterType: string,
  caller: UpstreamCaller,
): ProviderAdapter {
  const normalized = (adapterType || "").toLowerCase().trim();
  switch (normalized) {
    case "zhipu":
      return new ZhipuAdapter(caller);
    case "kimi":
      return new KimiAdapter(caller);
    case "deepseek":
      return new DeepSeekAdapter(caller);
    default:
      console.warn(`[adapter-registry] unknown adapter_type "${adapterType}", fallback to openai-compatible (deepseek) adapter`);
      return new DeepSeekAdapter(caller);
  }
}
