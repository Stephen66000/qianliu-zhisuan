import {
  createOpenAiCompatibleCaller,
  type OpenAiCompatibleCallerOptions,
  type UpstreamCaller,
} from "@qianliu/provider-adapters";
import { createFirstByteTimeoutPolicy } from "./upstream-timeout-policy.js";

type CallerFactory = (options: OpenAiCompatibleCallerOptions) => UpstreamCaller;

/** 生产 Caller 的唯一装配入口；测试可注入工厂冻结 main.ts 的实际参数。 */
export function createProductionUpstreamCaller(
  env: NodeJS.ProcessEnv,
  factory: CallerFactory = createOpenAiCompatibleCaller,
): UpstreamCaller {
  return factory(createProductionCallerOptions(env));
}

export function createProductionCallerOptions(
  env: NodeJS.ProcessEnv,
): OpenAiCompatibleCallerOptions {
  return {
    env,
    firstByteTimeoutMsForResource: createFirstByteTimeoutPolicy(env),
    streamIdleTimeoutMs: positiveEnvMs(env, "GATEWAY_UPSTREAM_STREAM_IDLE_TIMEOUT_MS", 45_000),
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
