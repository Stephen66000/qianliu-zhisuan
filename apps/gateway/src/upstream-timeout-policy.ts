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
    readPositiveMs(env, providerEnvName(provider, "FIRST_BYTE_TIMEOUT_MS"))
      ?? (provider === "kimi" ? KIMI_DEFAULT_MS : globalMs),
  ])) as Record<ProviderCode, number>;
  const modeMs = new Map<string, number | undefined>();
  for (const provider of PROVIDERS) {
    for (const mode of MODES) {
      modeMs.set(
        policyKey(provider, mode),
        readPositiveMs(env, modeEnvName(provider, mode, "FIRST_BYTE_TIMEOUT_MS")),
      );
    }
  }

  return (resource) => modeMs.get(policyKey(resource.providerCode, resource.mode))
    ?? (providerMs as Record<string, number | undefined>)[resource.providerCode]
    ?? globalMs;
}

const STREAM_IDLE_GLOBAL_MS = 45_000;
const ZHIPU_CODING_PLAN_STREAM_IDLE_MS = 120_000;

/**
 * 流式空闲门限优先级：厂商+模式 > 厂商 > 全局；智谱 Coding Plan 未配置时独立使用
 * 120 秒，其余厂商与智谱 API 未配置时回退全局 45 秒。POOL-034：避免 GLM-5.2 长推理
 * 块间静默超过 45 秒被全局空闲门限误判为超时。门限只放宽阈值，不改变按原始数据块
 * 重置计时的机制，也不放宽总请求时限。
 */
export function createStreamIdleTimeoutPolicy(
  env: NodeJS.ProcessEnv,
): (resource: AdapterResource) => number {
  const globalMs = readPositiveMs(env, "GATEWAY_UPSTREAM_STREAM_IDLE_TIMEOUT_MS")
    ?? STREAM_IDLE_GLOBAL_MS;
  const providerMs = Object.fromEntries(PROVIDERS.map((provider) => [
    provider,
    readPositiveMs(env, providerEnvName(provider, "STREAM_IDLE_TIMEOUT_MS"))
      ?? globalMs,
  ])) as Record<ProviderCode, number>;
  const modeMs = new Map<string, number | undefined>();
  for (const provider of PROVIDERS) {
    for (const mode of MODES) {
      const configured = readPositiveMs(
        env,
        modeEnvName(provider, mode, "STREAM_IDLE_TIMEOUT_MS"),
      );
      modeMs.set(
        policyKey(provider, mode),
        configured
          ?? (provider === "zhipu" && mode === "CODING_PLAN"
            ? ZHIPU_CODING_PLAN_STREAM_IDLE_MS
            : undefined),
      );
    }
  }

  return (resource) => {
    const key = policyKey(resource.providerCode, resource.mode);
    return modeMs.get(key)
      ?? (providerMs as Record<string, number | undefined>)[resource.providerCode]
      ?? globalMs;
  };
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

function providerEnvName(provider: ProviderCode, suffix: string): string {
  return `GATEWAY_${provider.toUpperCase()}_${suffix}`;
}

function modeEnvName(provider: ProviderCode, mode: ResourceMode, suffix: string): string {
  return `GATEWAY_${provider.toUpperCase()}_${mode}_${suffix}`;
}

function policyKey(provider: ProviderCode, mode: ResourceMode): string {
  return `${provider}:${mode}`;
}
