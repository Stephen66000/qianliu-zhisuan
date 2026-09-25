import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * 旧严格写激活 CLI 必须持续失败关闭（WP01 裁决①；WP04 回归护栏）。
 *
 * 背景：该入口原先只做单月守恒检查就把 `strict_writes_enabled` 置为 true，绕过候选、
 * 静默租约、30 分钟 TTL、事实水位复验与企业级幂等。WP04 新增了候选流程的三条接口后，
 * 这条旁路必须**继续**关闭——否则运维脚本可以绕开静默排空直接激活。
 *
 * 断言方式：以子进程运行真实入口，检查退出码 2（"入口已停用"，与业务冲突 1 区分）
 * 与 stderr 指引；并刻意传入不可达的 DATABASE_URL 证明它根本不尝试连库。
 */

const PACKAGE_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const CLI_ENTRY = fileURLToPath(new URL("./provider-finance-activate.ts", import.meta.url));

describe("旧严格写激活 CLI 失败关闭", () => {
  it("退出码 2 并输出候选流程指引，且不尝试连接数据库", () => {
    const result = spawnSync(`${PACKAGE_ROOT}node_modules/.bin/tsx`, [CLI_ENTRY], {
      cwd: PACKAGE_ROOT, encoding: "utf8", timeout: 60_000,
      env: { ...process.env, DATABASE_URL: "postgres://127.0.0.1:1/definitely-unreachable" },
    });

    expect(result.status, result.stderr).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("已停用");
    // 指引必须指向候选流程，而不是任何"直接激活"的替代入口。
    expect(result.stderr).toContain("/provider-finance/activation-preview");
    expect(result.stderr).toContain("/provider-finance/activate");
    expect(result.stderr).toContain("activateStrictWrites");
  }, 90_000);
});
