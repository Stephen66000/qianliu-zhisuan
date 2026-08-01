import { describe, it, expect } from "vitest";
import { loadConfig, PROVIDER_SECRET_ENV, CONFIG_VERSION } from "../index.js";

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
