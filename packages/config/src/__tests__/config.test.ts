import { describe, it, expect } from "vitest";
import { loadConfig, PROVIDER_SECRET_ENV, CONFIG_VERSION, readPositiveIntEnv } from "../index.js";

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
