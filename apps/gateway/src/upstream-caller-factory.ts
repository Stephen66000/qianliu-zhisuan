import {
  createOpenAiCompatibleCaller,
  type OpenAiCompatibleCallerOptions,
  type UpstreamCaller,
} from "@qianliu/provider-adapters";
import { createFirstByteTimeoutPolicy, createStreamIdleTimeoutPolicy } from "./upstream-timeout-policy.js";

type CallerFactory = (options: OpenAiCompatibleCallerOptions) => UpstreamCaller;
type ProductionCallerOptions = OpenAiCompatibleCallerOptions & { requestTimeoutMs: number };

// 总超时触发后为 Abort 传播、Attempt 结算和 fencing release 留出明确余量。
const HALF_OPEN_PROBE_LEASE_SAFETY_MS = 60_000;
// Coding Plan 并发租约 TTL 安全余量：至少覆盖总调用时限和结算／释放余量，
// 不再依赖仓储 60 秒默认值（统一 300 秒空闲窗口下长请求可能远超 60 秒）。
const CONCURRENCY_LEASE_SAFETY_MS = 60_000;

export interface ProductionUpstreamRuntime {
  caller: UpstreamCaller;
  requestTimeoutMs: number;
  halfOpenProbeLeaseMs: number;
  concurrencyLeaseTtlMs: number;
}

/** 兼容只需要 Caller 的调用方；与生产 runtime 共用同一装配。 */
export function createProductionUpstreamCaller(
  env: NodeJS.ProcessEnv,
  factory: CallerFactory = createOpenAiCompatibleCaller,
): UpstreamCaller {
  return createProductionUpstreamRuntime(env, factory).caller;
}

/** 生产唯一装配入口：同源生成 Caller、半开探针租期与并发租约 TTL，禁止配置链漂移。 */
export function createProductionUpstreamRuntime(
  env: NodeJS.ProcessEnv,
  factory: CallerFactory = createOpenAiCompatibleCaller,
): ProductionUpstreamRuntime {
  const options = createProductionCallerOptions(env, {
    onLegacyOverride: (legacyEnvName) => {
      console.warn(
        `[deprecated-config] ${legacyEnvName} 已不再控制流式空闲门限；`
        + "正式调用统一使用 GATEWAY_UPSTREAM_STREAM_IDLE_TIMEOUT_MS（默认 300000），请清理该变量",
      );
    },
  });
  const halfOpenProbeLeaseMs = options.requestTimeoutMs + HALF_OPEN_PROBE_LEASE_SAFETY_MS;
  if (!Number.isSafeInteger(halfOpenProbeLeaseMs)) {
    throw new Error(
      `GATEWAY_UPSTREAM_REQUEST_TIMEOUT_MS 过大，无法增加 ${HALF_OPEN_PROBE_LEASE_SAFETY_MS}ms 探针安全余量`,
    );
  }
  const concurrencyLeaseTtlMs = options.requestTimeoutMs + CONCURRENCY_LEASE_SAFETY_MS;
  if (!Number.isSafeInteger(concurrencyLeaseTtlMs)) {
    throw new Error(
      `GATEWAY_UPSTREAM_REQUEST_TIMEOUT_MS 过大，无法增加 ${CONCURRENCY_LEASE_SAFETY_MS}ms 并发租约安全余量`,
    );
  }
  return {
    caller: factory(options),
    requestTimeoutMs: options.requestTimeoutMs,
    halfOpenProbeLeaseMs,
    concurrencyLeaseTtlMs,
  };
}

export function createProductionCallerOptions(
  env: NodeJS.ProcessEnv,
  policyOptions: Parameters<typeof createStreamIdleTimeoutPolicy>[1] = {},
): ProductionCallerOptions {
  return {
    env,
    firstByteTimeoutMsForResource: createFirstByteTimeoutPolicy(env),
    streamIdleTimeoutMsForResource: createStreamIdleTimeoutPolicy(env, policyOptions),
    requestTimeoutMs: positiveEnvMs(env, "GATEWAY_UPSTREAM_REQUEST_TIMEOUT_MS", 10 * 60_000),
  };
}

function positiveEnvMs(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} 必须是正整数毫秒`);
  }
  return value;
}
