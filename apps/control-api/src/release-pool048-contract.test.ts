import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const script = fileURLToPath(new URL(
  "../../../deploy/scripts/release-v2.1-pool048-mac-mini.sh",
  import.meta.url,
));

describe("POOL20-048 Mac Mini 发布合同", () => {
  it("锁定候选、0054→0055、停写备份、失败保持停写与无 Tag 动作", () => {
    expect(execFileSync("bash", [script, "--check-contract"], { encoding: "utf8" }))
      .toContain("release_contract_check=PASS");
    const source = readFileSync(script, "utf8");
    expect(source).toContain('candidate_ref="refs/heads/codex/v2.1-upstream-error-evidence"');
    expect(source).toContain('candidate_commit="${CANDIDATE_COMMIT:?');
    expect(source).toContain('candidate_tree="${CANDIDATE_TREE:?');
    expect(source).toContain('product_commit="e2d64e93d5bd47612c162035796610358b6def2d"');
    expect(source).toContain('test "$source_head" = "0054_usage_aggregate_settlement_time"');
    expect(source).toContain('target_head="0055_upstream_error_evidence"');
    expect(source).toContain("pg_dump");
    expect(source).toContain("pg_restore -l");
    expect(source.indexOf("compose stop caddy gateway control-api web worker"))
      .toBeLessThan(source.indexOf("docker compose run --rm --no-deps migrate"));
    expect(source).toContain("migration changed database, business services remain stopped");
    expect(source).toContain("restore verified backup instead");
    expect(source).not.toContain("git tag");
    expect(source).not.toContain("push --tags");
  });
});
