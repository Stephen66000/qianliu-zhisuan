/**
 * Mode-aware Endpoint Policy（WP01，修复 RC-0）。
 *
 * 背景：生产 Provider 的 capability_set.base_url 为 Moonshot 平台地址
 * https://api.moonshot.cn/v1，被 Caller 优先采用，导致 Kimi Coding Plan Key
 * 被发送到平台 API，权限探针全部失败（前端显示 0 / 0）。
 *
 * 本模块是探针、真实验证、凭证恢复与 Gateway 正式业务调用共用的唯一
 * 模式化端点解析器；任何链路不得再直接读取 capability_set.base_url。
 *
 * 优先级（计划 7.2）：
 *   1. 资源模式专属显式地址（configuredEndpoints.endpoints[mode]）。
 *   2. 已标注 scope 的厂商端点配置（同上，结构化）。
 *   3. 对应模式的环境变量。
 *   4. 官方默认模式化地址兜底。
 *   5. 旧的无 scope base_url：
 *      - Kimi CODING_PLAN：已知 Moonshot 平台地址视为 API 模式地址，忽略；
 *        已知 Coding 地址视为标注正确的 Coding 地址；未知自定义域名按
 *        「歧义失败关闭」处理，要求管理员确认适用模式。
 *      - Kimi API：Moonshot 平台地址与自定义兼容地址均按 API 模式采用。
 *      - 非 Kimi 厂商保持既有行为（显式 base_url 优先）。
 */
import type { ResourceMode } from "./model-discovery-contract.js";
import { canonicalProviderCode } from "./provider-code.js";

export type EndpointOperation =
  | "MODEL_DISCOVERY_SOURCE"
  | "MODEL_PERMISSION_PROBE"
  | "CHAT_COMPLETIONS"
  | "ANTHROPIC_MESSAGES"
  | "CODING_PLAN_QUOTA";

/** capability_set 中的端点配置。endpoints 为模式化新结构；base_url 为历史通用地址。 */
export interface ConfiguredEndpoints {
  base_url?: string | null;
  endpoints?: Partial<Record<ResourceMode, string>> | null;
}

export type EndpointScope =
  | "MODE_SCOPED_CONFIG"
  | "ENV"
  | "LEGACY_BASE_URL"
  | "MODE_DEFAULT";

export type ResolvedEndpoint =
  | { ok: true; url: string; scope: EndpointScope; host: string; providerCode: string; operation: EndpointOperation; resourceMode: ResourceMode }
  | { ok: false; code: "ENDPOINT_SCOPE_AMBIGUOUS"; host: string | null; providerCode: string; operation: EndpointOperation; resourceMode: ResourceMode };

export const KIMI_API_MODE_DEFAULT_URL = "https://api.moonshot.cn/v1";
export const KIMI_CODING_PLAN_DEFAULT_URL = "https://api.kimi.com/coding/v1";
/** Kimi Code usages 额度端点（官方 CLI 使用）。 */
export const KIMI_CODING_PLAN_QUOTA_URL = "https://api.kimi.com/coding/v1/usages";
/** 智谱 Coding Plan 额度端点。 */
export const ZHIPU_CODING_PLAN_QUOTA_URL = "https://open.bigmodel.cn/api/monitor/usage/quota/limit";

const KIMI_API_HOSTS = new Set(["api.moonshot.cn"]);
const KIMI_CODING_HOSTS = new Set(["api.kimi.com"]);

function hostOf(rawUrl: string): string | null {
  try {
    return new URL(rawUrl).host;
  } catch {
    return null;
  }
}

function ok(
  providerCode: string, operation: EndpointOperation, resourceMode: ResourceMode,
  url: string, scope: EndpointScope,
): ResolvedEndpoint {
  return { ok: true, url, scope, host: hostOf(url) ?? url, providerCode, operation, resourceMode };
}

/** Kimi 模式化解析：API 模式与 CODING_PLAN 模式分开决策（RC-0 核心）。 */
function resolveKimiEndpoint(
  operation: EndpointOperation,
  mode: ResourceMode,
  legacyBaseUrl: string | undefined,
  env: NodeJS.ProcessEnv,
): ResolvedEndpoint {
  if (operation === "CODING_PLAN_QUOTA") {
    return { ok: true, url: KIMI_CODING_PLAN_QUOTA_URL, scope: "MODE_DEFAULT", host: hostOf(KIMI_CODING_PLAN_QUOTA_URL) ?? KIMI_CODING_PLAN_QUOTA_URL, providerCode: "kimi", operation, resourceMode: mode };
  }
  if (mode === "CODING_PLAN") {
    const envUrl = env.KIMI_CODING_BASE_URL?.trim();
    if (envUrl) return { ok: true, url: envUrl, scope: "ENV", host: hostOf(envUrl) ?? envUrl, providerCode: "kimi", operation, resourceMode: mode };
    // 旧 base_url 兼容：仅当它本身指向 Coding 主机时采用；
    // Moonshot 平台地址是 API 模式地址，不得覆盖 Coding 端点（RC-0）；
    // 未知自定义域名歧义 → 失败关闭。
    if (legacyBaseUrl) {
      const host = hostOf(legacyBaseUrl);
      if (host && KIMI_CODING_HOSTS.has(host)) {
        return { ok: true, url: legacyBaseUrl, scope: "LEGACY_BASE_URL", host, providerCode: "kimi", operation, resourceMode: mode };
      }
      if (host && KIMI_API_HOSTS.has(host)) {
        return { ok: true, url: KIMI_CODING_PLAN_DEFAULT_URL, scope: "MODE_DEFAULT", host: hostOf(KIMI_CODING_PLAN_DEFAULT_URL) ?? KIMI_CODING_PLAN_DEFAULT_URL, providerCode: "kimi", operation, resourceMode: mode };
      }
      return { ok: false, code: "ENDPOINT_SCOPE_AMBIGUOUS", host, providerCode: "kimi", operation, resourceMode: mode };
    }
    return { ok: true, url: KIMI_CODING_PLAN_DEFAULT_URL, scope: "MODE_DEFAULT", host: hostOf(KIMI_CODING_PLAN_DEFAULT_URL) ?? KIMI_CODING_PLAN_DEFAULT_URL, providerCode: "kimi", operation, resourceMode: mode };
  }
  // Kimi API 模式。
  const envUrl = env.KIMI_API_BASE_URL?.trim();
  if (envUrl) return { ok: true, url: envUrl, scope: "ENV", host: hostOf(envUrl) ?? envUrl, providerCode: "kimi", operation, resourceMode: mode };
  if (legacyBaseUrl) {
    const host = hostOf(legacyBaseUrl);
    // Coding 地址不能反向充当 API 模式业务地址。
    if (host && KIMI_CODING_HOSTS.has(host)) {
      return { ok: false, code: "ENDPOINT_SCOPE_AMBIGUOUS", host, providerCode: "kimi", operation, resourceMode: mode };
    }
    return { ok: true, url: legacyBaseUrl, scope: "LEGACY_BASE_URL", host: host ?? legacyBaseUrl, providerCode: "kimi", operation, resourceMode: mode };
  }
  return { ok: true, url: KIMI_API_MODE_DEFAULT_URL, scope: "MODE_DEFAULT", host: hostOf(KIMI_API_MODE_DEFAULT_URL) ?? KIMI_API_MODE_DEFAULT_URL, providerCode: "kimi", operation, resourceMode: mode };
}

/**
 * 模式化端点解析。所有 Adapter 链路（权限探针、真实验证、凭证恢复、
 * Gateway 业务调用、额度同步、模型发现来源）统一从这里取地址。
 */
export function resolveProviderEndpoint(input: {
  providerCode: string;
  resourceMode: ResourceMode;
  operation: EndpointOperation;
  configuredEndpoints?: ConfiguredEndpoints | null;
  env?: NodeJS.ProcessEnv;
}): ResolvedEndpoint {
  const providerCode = canonicalProviderCode(input.providerCode);
  const mode = input.resourceMode;
  const env = input.env ?? process.env;
  const configured = input.configuredEndpoints ?? {};
  const scopedExplicit = configured.endpoints?.[mode]?.trim() || undefined;
  const legacyBaseUrl = configured.base_url?.trim() || undefined;

  if (providerCode === "kimi") {
    if (scopedExplicit) return ok(providerCode, input.operation, mode, scopedExplicit, "MODE_SCOPED_CONFIG");
    return resolveKimiEndpoint(input.operation, mode, legacyBaseUrl, env);
  }

  // 非 Kimi 厂商：保持既有行为（显式地址 > 环境变量/默认值），不引入回归。
  if (input.operation === "CODING_PLAN_QUOTA") {
    if (providerCode === "zhipu") return ok(providerCode, input.operation, mode, ZHIPU_CODING_PLAN_QUOTA_URL, "MODE_DEFAULT");
    return { ok: false, code: "ENDPOINT_SCOPE_AMBIGUOUS", host: null, providerCode, operation: input.operation, resourceMode: mode };
  }
  if (scopedExplicit) return ok(providerCode, input.operation, mode, scopedExplicit, "MODE_SCOPED_CONFIG");
  if (legacyBaseUrl) return ok(providerCode, input.operation, mode, legacyBaseUrl, "LEGACY_BASE_URL");
  const envKey = LEGACY_CHAT_BASE_URL_ENV[providerCode];
  const envUrl = envKey ? env[envKey]?.trim() : undefined;
  if (envUrl) return ok(providerCode, input.operation, mode, envUrl, "ENV");
  const fallback = LEGACY_CHAT_DEFAULT_BASE_URL[providerCode];
  if (fallback) return ok(providerCode, input.operation, mode, fallback, "MODE_DEFAULT");
  const generic = env[`${input.providerCode.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_BASE_URL`]?.trim();
  if (generic) return ok(providerCode, input.operation, mode, generic, "ENV");
  return { ok: false, code: "ENDPOINT_SCOPE_AMBIGUOUS", host: null, providerCode, operation: input.operation, resourceMode: mode };
}

/** 与 openai-compatible-caller 既有映射保持一致，避免行为回归。 */
const LEGACY_CHAT_BASE_URL_ENV: Record<string, string> = {
  deepseek: "DEEPSEEK_BASE_URL",
  zhipu: "ZHIPU_CODING_BASE_URL",
  qwen: "QWEN_BASE_URL",
  minimax: "MINIMAX_BASE_URL",
  openai: "OPENAI_BASE_URL",
  siliconflow: "SILICONFLOW_BASE_URL",
};

const LEGACY_CHAT_DEFAULT_BASE_URL: Record<string, string> = {
  deepseek: "https://api.deepseek.com",
  zhipu: "https://open.bigmodel.cn/api/coding/paas/v4",
  qwen: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  minimax: "https://api.minimax.chat/v1",
  openai: "https://api.openai.com/v1",
  siliconflow: "https://api.siliconflow.cn/v1",
};
