import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveAppVersion } from "./version-route.js";

describe("resolveAppVersion 版本解析", () => {
  let sandbox: string;

  beforeEach(() => {
    sandbox = mkdtempSync(path.join(tmpdir(), "version-route-"));
  });

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  it("APP_VERSION 环境变量优先于 VERSION 文件", () => {
    writeFileSync(path.join(sandbox, "VERSION"), "2.5.1\n");
    expect(resolveAppVersion({ APP_VERSION: "9.9.9-rc" }, sandbox)).toBe("9.9.9-rc");
  });

  it("从起始目录向上回溯找到仓库根 VERSION 文件", () => {
    writeFileSync(path.join(sandbox, "VERSION"), "2.5.1\n");
    const nested = path.join(sandbox, "apps", "control-api");
    mkdirSync(nested, { recursive: true });
    expect(resolveAppVersion({}, nested)).toBe("2.5.1");
  });

  it("VERSION 内容非法时继续向上，最终不可得返回 null", () => {
    writeFileSync(path.join(sandbox, "VERSION"), "not-a-version\n");
    expect(resolveAppVersion({}, sandbox)).toBeNull();
  });

  it("没有任何 VERSION 文件且未设环境变量时返回 null", () => {
    expect(resolveAppVersion({}, sandbox)).toBeNull();
  });
});
