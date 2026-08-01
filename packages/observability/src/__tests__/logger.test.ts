import { describe, it, expect } from "vitest";
import { MetadataLogger } from "../logger.js";
import { scanCanary, createLogSinkFromBuffer, OBSERVABILITY_VERSION } from "../index.js";

describe("@qianliu/observability MetadataLogger", () => {
  it("白名单过滤生效：非白名单字段不进日志", () => {
    let buf = "";
    const logger = new MetadataLogger((line) => {
      buf += line + "\n";
    });
    const SECRET = "SUPER_SECRET_BODY_CANARY";
    // body / prompt 不在白名单
    logger.info("evt", { requestId: "r1", body: SECRET, prompt: SECRET });
    expect(buf).not.toContain(SECRET);
    expect(buf).toContain("r1");
    expect(buf).toContain('"event":"evt"');
  });
});

describe("scanCanary 框架", () => {
  it("命中时 total > 0、passed=false", async () => {
    const text = "contains THE_CANARY here";
    const result = await scanCanary("THE_CANARY", [
      createLogSinkFromBuffer({ text: () => text }),
    ]);
    expect(result.total).toBe(1);
    expect(result.passed).toBe(false);
  });

  it("未命中时 total === 0、passed=true", async () => {
    const result = await scanCanary("NOPE", [
      createLogSinkFromBuffer({ text: () => "clean text" }),
    ]);
    expect(result.total).toBe(0);
    expect(result.passed).toBe(true);
    expect(result.complete).toBe(false);
    expect(result.hits.postgres).toBeNull();
    expect(result.scannedKinds).toEqual(["logs"]);
    expect(result.unscannedKinds).toEqual(["postgres", "redis", "traces"]);
  });

  it("必需存储缺少扫描器时不得通过", async () => {
    const result = await scanCanary(
      "NOPE",
      [createLogSinkFromBuffer({ text: () => "clean text" })],
      ["postgres", "redis", "logs", "traces"],
    );
    expect(result.passed).toBe(false);
    expect(result.complete).toBe(false);
  });

  it("exposes version", () => {
    expect(OBSERVABILITY_VERSION).toBe("0.3.0");
  });
});
