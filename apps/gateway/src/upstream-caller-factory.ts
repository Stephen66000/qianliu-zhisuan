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

export interface ProductionUpstreamRuntime {
  caller: UpstreamCaller;
  requestTimeoutMs: number;
  halfOpenProbeLeaseMs: number;
}

/** 兼容只需要 Caller 的调用方；与生产 runtime 共用同一装配。 */
export function createProductionUpstreamCaller(
  env: NodeJS.ProcessEnv,
  factory: CallerFactory = createOpenAiCompatibleCaller,
): UpstreamCaller {
  return createProductionUpstreamRuntime(env, factory).caller;
}

/** 生产唯一装配入口：同源生成 Caller 与半开探针租期，禁止配置链漂移。 */
export function createProductionUpstreamRuntime(
  env: NodeJS.ProcessEnv,
  factory: CallerFactory = createOpenAiCompatibleCaller,
): ProductionUpstreamRuntime {
  const options = createProductionCallerOptions(env);
  const halfOpenProbeLeaseMs = options.requestTimeoutMs + HALF_OPEN_PROBE_LEASE_SAFETY_MS;
  if (!Number.isSafeInteger(halfOpenProbeLeaseMs)) {
    throw new Error(
      `GATEWAY_UPSTREAM_REQUEST_TIMEOUT_MS 过大，无法增加 ${HALF_OPEN_PROBE_LEASE_SAFETY_MS}ms 探针安全余量`,
    );
  }
  return {
    caller: factory(options),
    requestTimeoutMs: options.requestTimeoutMs,
    halfOpenProbeLeaseMs,
  };
}

export function createProductionCallerOptions(
  env: NodeJS.ProcessEnv,
): ProductionCallerOptions {
  return {
    env,
    firstByteTimeoutMsForResource: createFirstByteTimeoutPolicy(env),
    streamIdleTimeoutMsForResource: createStreamIdleTimeoutPolicy(env),
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
