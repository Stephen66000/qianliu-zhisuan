import type { AdapterResource } from "@qianliu/provider-adapters";

const PROVIDERS = ["deepseek", "zhipu", "kimi"] as const;
const MODES = ["API", "CODING_PLAN"] as const;
const GLOBAL_DEFAULT_MS = 30_000;
const KIMI_DEFAULT_MS = 120_000;

type ProviderCode = AdapterResource["providerCode"];
type ResourceMode = AdapterResource["mode"];

/**
 * 首字节门限优先级：厂商+模式 > 厂商 > 全局；Kimi 未配置时独立使用 120 秒。
 * 所有已知配置在 Gateway 启动时一次性校验，禁止无效值延迟到真实请求才暴露。
 */
export function createFirstByteTimeoutPolicy(
  env: NodeJS.ProcessEnv,
): (resource: AdapterResource) => number {
  const globalMs = readPositiveMs(env, "GATEWAY_UPSTREAM_FIRST_BYTE_TIMEOUT_MS")
    ?? GLOBAL_DEFAULT_MS;
  const providerMs = Object.fromEntries(PROVIDERS.map((provider) => [
    provider,
    readPositiveMs(env, providerEnvName(provider))
      ?? (provider === "kimi" ? KIMI_DEFAULT_MS : globalMs),
  ])) as Record<ProviderCode, number>;
  const modeMs = new Map<string, number | undefined>();
  for (const provider of PROVIDERS) {
    for (const mode of MODES) {
      modeMs.set(
        policyKey(provider, mode),
        readPositiveMs(env, modeEnvName(provider, mode)),
      );
    }
  }

  return (resource) => modeMs.get(policyKey(resource.providerCode, resource.mode))
    ?? providerMs[resource.providerCode];
}

function readPositiveMs(env: NodeJS.ProcessEnv, name: string): number | undefined {
  const raw = env[name];
  if (raw === undefined || raw === "") return undefined;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} 必须是正整数毫秒`);
  }
  return value;
}

function providerEnvName(provider: ProviderCode): string {
  return `GATEWAY_${provider.toUpperCase()}_FIRST_BYTE_TIMEOUT_MS`;
}

function modeEnvName(provider: ProviderCode, mode: ResourceMode): string {
  return `GATEWAY_${provider.toUpperCase()}_${mode}_FIRST_BYTE_TIMEOUT_MS`;
}

function policyKey(provider: ProviderCode, mode: ResourceMode): string {
  return `${provider}:${mode}`;
}
