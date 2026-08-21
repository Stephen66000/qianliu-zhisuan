import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const script = fileURLToPath(new URL("../../../deploy/scripts/release-v2.1-r2-mac-mini.sh", import.meta.url));

describe("2.1 第二轮 Mac Mini 发布合同", () => {
  it("绑定分支、候选 SHA、0052/0054 基线、备份停写和失败保持停写边界", () => {
    expect(execFileSync("bash", [script, "--check-contract"], { encoding: "utf8" }))
      .toContain("release_contract_check=PASS");
    const source = readFileSync(script, "utf8");
    expect(source).toContain('candidate_ref="refs/heads/codex/v2.1-test-fixes-r2"');
    expect(source).toContain('repo_url="https://github.com/Stephen66000/qianliu-zhisuan.git"');
    expect(source).toContain('candidate_commit="${CANDIDATE_COMMIT:?');
    expect(source).toContain('candidate_tree="${CANDIDATE_TREE:?');
    expect(source).toContain('target_head="0054_usage_aggregate_settlement_time"');
    expect(source).toContain('"0052_dispatch_restore_and_resource_utilization"|"$target_head"');
    expect(source).toContain("pg_dump");
    expect(source.indexOf("compose stop caddy gateway control-api web worker"))
      .toBeLessThan(source.indexOf("docker compose run --rm --no-deps migrate"));
    expect(source).toContain("migration changed database, business services remain stopped");
    expect(source).toContain("restore verified backup instead");
    expect(source).not.toContain("git tag");
  });
});
