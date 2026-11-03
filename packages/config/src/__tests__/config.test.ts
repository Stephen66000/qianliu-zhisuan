import { describe, it, expect } from "vitest";
import {
  loadConfig,
  PROVIDER_SECRET_ENV,
  CONFIG_VERSION,
  readFeatureFlags,
  readProviderFinanceMode,
  readProviderOperatingSyncIntervalMs,
  readProviderOperatingBalanceExpireMs,
  readProviderOperatingBalanceRefreshCooldownMs,
  readPositiveIntEnv,
} from "../index.js";

describe("@qianliu/config", () => {
  it("exposes version", () => {
    expect(CONFIG_VERSION).toBe("0.3.0");
  });

  it("Provider 环境变量名冻结（TRD §17）", () => {
    expect(PROVIDER_SECRET_ENV).toEqual({
      deepseek: "DEEPSEEK_API_KEY",
      zhipu: "ZHIPU_CODING_TOKEN",
      kimi: "KIMI_CODING_TOKEN",
    });
  });

  it("loadConfig 解析完整配置并默认 METADATA_ONLY", () => {
    const cfg = loadConfig({
      DATABASE_URL: "postgres://u:p@h:5432/db",
      REDIS_URL: "redis://h:6379",
      GATEWAY_KEY_PEPPER: "a".repeat(32),
      SESSION_AFFINITY_HMAC_KEY: "b".repeat(32),
      CREDENTIAL_KEK: "c".repeat(32),
      DEEPSEEK_API_KEY: "sk-real",
    });
    expect(cfg.contentRetentionMode).toBe("METADATA_ONLY");
    expect(cfg.database.url).toBe("postgres://u:p@h:5432/db");
    expect(cfg.credentialKek).toBe("c".repeat(32));
    expect(cfg.runtimeAssurance).toEqual({ mode: "OBSERVE", wecomNotify: false });
    expect(Object.values(cfg.featureFlags)).toEqual([false, false, false, false, false]);
    expect(cfg.providers.find((p) => p.code === "deepseek")?.configured).toBe(true);
    expect(cfg.providers.find((p) => p.code === "zhipu")?.configured).toBe(false);
  });

  it("拒绝过短的 Pepper", () => {
    expect(() =>
      loadConfig({
        DATABASE_URL: "postgres://u:p@h:5432/db",
        REDIS_URL: "redis://h:6379",
        GATEWAY_KEY_PEPPER: "short",
        SESSION_AFFINITY_HMAC_KEY: "b".repeat(32),
        CREDENTIAL_KEK: "c".repeat(32),
      }),
    ).toThrow();
  });

  it("严格解析三级运行模式和企微通知开关", () => {
    const base = {
      DATABASE_URL: "postgres://u:p@h:5432/db",
      REDIS_URL: "redis://h:6379",
      GATEWAY_KEY_PEPPER: "a".repeat(32),
      SESSION_AFFINITY_HMAC_KEY: "b".repeat(32),
      CREDENTIAL_KEK: "c".repeat(32),
    };
    expect(
      loadConfig({
        ...base,
        RUNTIME_ASSURANCE_MODE: "ENFORCE",
        RUNTIME_ASSURANCE_WECOM_NOTIFY: "true",
      }).runtimeAssurance,
    ).toEqual({ mode: "ENFORCE", wecomNotify: true });
    expect(() => loadConfig({ ...base, RUNTIME_ASSURANCE_MODE: "enforce" })).toThrow();
    expect(() =>
      loadConfig({ ...base, RUNTIME_ASSURANCE_WECOM_NOTIFY: "TRUE" }),
    ).toThrow();
  });

  it("2.0 Feature Flag 测试环境默认开启，其他环境默认关闭", () => {
    expect(Object.values(readFeatureFlags({ NODE_ENV: "test" }))).toEqual([
      true, true, true, true, true,
    ]);
    expect(Object.values(readFeatureFlags({ NODE_ENV: "production" }))).toEqual([
      false, false, false, false, false,
    ]);
  });

  it("2.0 Feature Flag 只接受小写 true/false", () => {
    expect(readFeatureFlags({
      NODE_ENV: "production",
      FEATURE_USAGE_OVERVIEW_V2: "true",
    }).FEATURE_USAGE_OVERVIEW_V2).toBe(true);
    expect(() => readFeatureFlags({ FEATURE_USAGE_OVERVIEW_V2: "TRUE" })).toThrow();
  });

  it("资金账本模式默认ACTIVE且只接受三级枚举", () => {
    expect(readProviderFinanceMode({})).toBe("ACTIVE");
    expect(readProviderFinanceMode({ NODE_ENV: "production" })).toBe("ACTIVE");
    expect(readProviderFinanceMode({ NODE_ENV: "production", PROVIDER_FINANCE_MODE: "DARK" }))
      .toBe("DARK");
    expect(readProviderFinanceMode({ NODE_ENV: "production", PROVIDER_FINANCE_MODE: "OFF" }))
      .toBe("OFF");
    expect(() => readProviderFinanceMode({ PROVIDER_FINANCE_MODE: "active" })).toThrow();
  });
});

describe("readPositiveIntEnv（H-1：gateway/control-api 共享）", () => {
  it("未设 → 默认值", () => {
    expect(readPositiveIntEnv({}, "FOO", 42)).toBe(42);
    expect(readPositiveIntEnv({ FOO: "" }, "FOO", 42)).toBe(42);
  });

  it("合法正整数 → 采用", () => {
    expect(readPositiveIntEnv({ FOO: "1048576" }, "FOO", 42)).toBe(1_048_576);
  });

  it("非法值 → 抛错（fail-fast）", () => {
    expect(() => readPositiveIntEnv({ FOO: "abc" }, "FOO", 42)).toThrow();
    expect(() => readPositiveIntEnv({ FOO: "0" }, "FOO", 42)).toThrow();
    expect(() => readPositiveIntEnv({ FOO: "-1" }, "FOO", 42)).toThrow();
    expect(() => readPositiveIntEnv({ FOO: "1.5" }, "FOO", 42)).toThrow();
  });

  it("错误信息含 unitLabel", () => {
    expect(() => readPositiveIntEnv({ FOO: "x" }, "FOO", 42, "字节")).toThrow(/字节/);
  });
});

describe("官方余额同步配置（WP3 P1/P2/P3：建议默认值，可配置；P1 按厂商限制可调，DeepSeek 限流未核实）", () => {
  it("未设 → 建议默认值：P1=900000ms（15min）P2=1800000ms（30min）P3=30000ms（30s）", () => {
    expect(readProviderOperatingSyncIntervalMs({})).toBe(900_000);
    expect(readProviderOperatingBalanceExpireMs({})).toBe(1_800_000);
    expect(readProviderOperatingBalanceRefreshCooldownMs({})).toBe(30_000);
  });

  it("显式 env → 采用配置值（毫秒）", () => {
    expect(readProviderOperatingSyncIntervalMs({ PROVIDER_OPERATING_SYNC_INTERVAL_MS: "60000" })).toBe(60_000);
    expect(readProviderOperatingBalanceExpireMs({ PROVIDER_OPERATING_BALANCE_EXPIRE_MS: "3600000" })).toBe(3_600_000);
    expect(readProviderOperatingBalanceRefreshCooldownMs({
      PROVIDER_OPERATING_BALANCE_REFRESH_COOLDOWN_MS: "5000",
    })).toBe(5_000);
  });

  it("非法值 → fail-fast 抛错且错误信息含变量名与单位", () => {
    expect(() => readProviderOperatingSyncIntervalMs({ PROVIDER_OPERATING_SYNC_INTERVAL_MS: "0" }))
      .toThrow(/PROVIDER_OPERATING_SYNC_INTERVAL_MS/);
    expect(() => readProviderOperatingSyncIntervalMs({ PROVIDER_OPERATING_SYNC_INTERVAL_MS: "-100" }))
      .toThrow(/毫秒/);
    expect(() => readProviderOperatingBalanceExpireMs({ PROVIDER_OPERATING_BALANCE_EXPIRE_MS: "abc" }))
      .toThrow(/PROVIDER_OPERATING_BALANCE_EXPIRE_MS/);
    expect(() => readProviderOperatingBalanceRefreshCooldownMs({
      PROVIDER_OPERATING_BALANCE_REFRESH_COOLDOWN_MS: "1.5",
    })).toThrow(/PROVIDER_OPERATING_BALANCE_REFRESH_COOLDOWN_MS/);
  });
});
