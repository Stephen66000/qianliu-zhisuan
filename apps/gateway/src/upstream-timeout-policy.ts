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

const STREAM_IDLE_GLOBAL_MS = 300_000;

/** 统一空闲门限前的旧厂商/模式覆盖变量；仅提示弃用，不参与解析。 */
const LEGACY_STREAM_IDLE_ENV_NAMES = PROVIDERS.flatMap((provider) => [
  `GATEWAY_${provider.toUpperCase()}_STREAM_IDLE_TIMEOUT_MS`,
  ...MODES.map((mode) => `GATEWAY_${provider.toUpperCase()}_${mode}_STREAM_IDLE_TIMEOUT_MS`),
]);

/**
 * 流式空闲门限：正式调用统一 300 秒，单一来源，厂商和模式无关。
 * 智谱 Coding Plan 120 秒特例与厂商／模式覆盖不再生效；旧变量仅产生一次
 * 脱敏弃用提示（只输出变量名，不输出值）。POOL-034 的初始诉求（GLM-5.2
 * 长推理块间静默）由统一 300 秒门限覆盖。门限只放宽阈值，不改变按原始
 * 数据块重置计时的机制，也不放宽总请求时限。
 */
export function createStreamIdleTimeoutPolicy(
  env: NodeJS.ProcessEnv,
  options: {
    /** 每个旧覆盖变量命中时回调一次；生产装配注入启动日志。 */
    onLegacyOverride?: (legacyEnvName: string) => void;
  } = {},
): (resource: AdapterResource) => number {
  const globalMs = readPositiveMs(env, "GATEWAY_UPSTREAM_STREAM_IDLE_TIMEOUT_MS")
    ?? STREAM_IDLE_GLOBAL_MS;
  for (const legacyName of LEGACY_STREAM_IDLE_ENV_NAMES) {
    if (env[legacyName] !== undefined && env[legacyName] !== "") {
      options.onLegacyOverride?.(legacyName);
    }
  }
  return () => globalMs;
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
