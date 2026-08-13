/**
 * @qianliu/config — 配置 Schema，不含 Secret。
 *
 * 工程规则 §5：真实 Secret 只从进程环境、Docker Secret 或正式 Secret Manager 注入。
 * 本包只负责把环境变量解析+校验为强类型配置对象；不读真实 Secret，不持久化。
 * 依据：TRD §17（环境变量名冻结）、§14.3（METADATA_ONLY 固定）、§5.3/§5.4（Pepper/凭证来源）。
 */
import { z } from "zod";

/** 内容留存模式。TRD §14.3 行 788：当前版本固定 METADATA_ONLY，schema 强制不改值。 */
const ContentRetentionModeSchema = z.literal("METADATA_ONLY");

/** RA-W01：平台级运行模式。默认 OBSERVE，先观察再执行。 */
export const RuntimeAssuranceModeSchema = z.enum(["OFF", "OBSERVE", "ENFORCE"]);

/** 环境变量布尔值严格只接受小写 true/false，避免字符串 truthy 误开启通知。 */
const StrictEnvBooleanSchema = z
  .enum(["true", "false"])
  .transform((value) => value === "true");

/** 2.0 新增能力开关（TRD §13.4）。键名与部署环境变量保持一致。 */
export const FEATURE_FLAG_NAMES = [
  "FEATURE_DIRECTORY_IMPORT",
  "FEATURE_USAGE_OVERVIEW_V2",
  "FEATURE_DEPARTMENT_COST",
  "FEATURE_RESOURCE_UTILIZATION_V2",
  "FEATURE_PROCUREMENT_REVIEW",
] as const;

export type FeatureFlagName = (typeof FEATURE_FLAG_NAMES)[number];
export type FeatureFlags = Record<FeatureFlagName, boolean>;

const FeatureFlagsSchema = z.object({
  FEATURE_DIRECTORY_IMPORT: z.boolean(),
  FEATURE_USAGE_OVERVIEW_V2: z.boolean(),
  FEATURE_DEPARTMENT_COST: z.boolean(),
  FEATURE_RESOURCE_UTILIZATION_V2: z.boolean(),
  FEATURE_PROCUREMENT_REVIEW: z.boolean(),
});

/**
 * 读取 2.0 Feature Flag。测试环境默认逐项开启，其他环境需显式开启。
 * 只接受小写 true/false，避免配置拼写导致意外放量。
 */
export function readFeatureFlags(env: NodeJS.ProcessEnv = process.env): FeatureFlags {
  const defaultValue = env.NODE_ENV === "test" ? "true" : "false";
  return FeatureFlagsSchema.parse(Object.fromEntries(
    FEATURE_FLAG_NAMES.map((name) => [
      name,
      StrictEnvBooleanSchema.parse(env[name] ?? defaultValue),
    ]),
  ));
}

/** Provider 代码（与上游环境变量一一对应，TRD §17 行 943）。 */
const ProviderCodeSchema = z.enum(["deepseek", "zhipu", "kimi"]);

/** 单个 Provider 凭证来源描述。configured 只表示环境变量非空，不代表凭证有效。 */
const ProviderCredentialSchema = z.object({
  code: ProviderCodeSchema,
  /** 环境变量名（DEEPSEEK_API_KEY 等）。 */
  secretEnv: z.string(),
  /** 凭证值，运行时从 process.env 注入；W01 不读真实值，只声明来源。 */
  configured: z.boolean(),
});

/** 环境变量名冻结表（TRD §17 行 943）。 */
export const PROVIDER_SECRET_ENV: Record<z.infer<typeof ProviderCodeSchema>, string> = {
  deepseek: "DEEPSEEK_API_KEY",
  zhipu: "ZHIPU_CODING_TOKEN",
  kimi: "KIMI_CODING_TOKEN",
};

/** 应用配置 Schema。 */
export const AppConfigSchema = z.object({
  nodeEnv: z.enum(["development", "test", "pilot", "production"]),
  logLevel: z.enum(["debug", "info", "warn", "error"]),
  /** 内容留存模式。默认且固定 METADATA_ONLY。 */
  contentRetentionMode: ContentRetentionModeSchema.default("METADATA_ONLY"),

  database: z.object({
    url: z.string().min(1),
  }),
  redis: z.object({
    url: z.string().min(1),
  }),

  /** 下游 Key 的服务端 Pepper（不与摘要同库存储）。从环境注入。 */
  gatewayKeyPepper: z.string().min(16),
  /** Session Affinity HMAC 密钥（独立于 Pepper，支持轮换）。从环境注入。 */
  sessionAffinityHmacKey: z.string().min(16),
  /** 上游凭证信封加密的 KEK（32 字节 base64）。从环境注入，不与密文同库。 */
  credentialKek: z.string().min(16),

  runtimeAssurance: z.object({
    mode: RuntimeAssuranceModeSchema.default("OBSERVE"),
    /** 只控制正式熔断／恢复消息；管理员测试发送不受该开关代替授权。 */
    wecomNotify: z.boolean().default(false),
  }),

  /** 2.0 新增页面、API 与 Worker 开关；不影响 Gateway 和 1.0 能力。 */
  featureFlags: FeatureFlagsSchema,

  /** Provider 凭证来源描述（不持有明文，只描述是否已配置）。 */
  providers: z.array(ProviderCredentialSchema),
});

export type AppConfig = z.infer<typeof AppConfigSchema>;

/**
 * 从 process.env（或自定义源）解析应用配置。
 * 不读取真实 Secret 明文到返回对象——只标记 configured 布尔。
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const providerCodes = Object.keys(PROVIDER_SECRET_ENV) as Array<
    keyof typeof PROVIDER_SECRET_ENV
  >;
  const providers = providerCodes.map((code) => {
    const secretEnv = PROVIDER_SECRET_ENV[code];
    return {
      code,
      secretEnv,
      configured: Boolean(env[secretEnv] && env[secretEnv]!.length > 0),
    };
  });

  return AppConfigSchema.parse({
    nodeEnv: env.NODE_ENV ?? "development",
    logLevel: env.LOG_LEVEL ?? "info",
    contentRetentionMode: env.CONTENT_RETENTION_MODE ?? "METADATA_ONLY",
    database: { url: env.DATABASE_URL },
    redis: { url: env.REDIS_URL },
    gatewayKeyPepper: env.GATEWAY_KEY_PEPPER,
    sessionAffinityHmacKey: env.SESSION_AFFINITY_HMAC_KEY,
    credentialKek: env.CREDENTIAL_KEK,
    runtimeAssurance: {
      mode: env.RUNTIME_ASSURANCE_MODE ?? "OBSERVE",
      wecomNotify: StrictEnvBooleanSchema.parse(
        env.RUNTIME_ASSURANCE_WECOM_NOTIFY ?? "false",
      ),
    },
    featureFlags: readFeatureFlags(env),
    providers,
  });
}

export const CONFIG_VERSION = "0.3.0" as const;

/**
 * 读取正整数环境变量（H-1：gateway/control-api 共享，避免两份同构逻辑漂移）。
 *
 * 未设或空串 → 返回 defaultValue；非法值（非整数、<=0）→ 启动期抛错（fail-fast）。
 * 用于 bodyLimit 字节数等"正整数"配置。unitLabel 仅用于错误信息。
 */
export function readPositiveIntEnv(
  env: NodeJS.ProcessEnv,
  name: string,
  defaultValue: number,
  unitLabel = "",
): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return defaultValue;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} 必须是正整数${unitLabel ? `（${unitLabel}）` : ""}`);
  }
  return value;
}
