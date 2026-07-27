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
    providers,
  });
}

export const CONFIG_VERSION = "0.3.0" as const;
