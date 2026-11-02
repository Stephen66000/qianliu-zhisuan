import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

// Keep every checked report reproducible; the disposition gate must never rely on an old run.
const suites = [
  ["packages/domain", "stryker.config.json"],
  ["apps/worker", "stryker.config.json"],
  ["packages/database", "stryker.pool029.config.json"],
  ["packages/database", "stryker.pool039.config.json"],
  ["apps/gateway", "stryker.pool039.config.json"],
  ["apps/gateway", "stryker.pool040.config.json"],
  ["packages/database", "stryker.pool043.config.json"],
  ["packages/database", "stryker.pool043-v22.config.json"],
  ["apps/gateway", "stryker.pool043.config.json"],
  ["packages/database", "stryker.pool039043-integration.config.json"],
  [".", "stryker.resource-pool.config.json"],
  ["packages/provider-adapters", "stryker.pool021-r2.config.json"],
  ["apps/gateway", "stryker.pool030.config.json"],
  ["packages/provider-adapters", "stryker.pool030.config.json"],
];
const root = process.cwd();
const env = { ...process.env, CI: "1" };
for (const key of Object.keys(env)) {
  if (key === "DATABASE_URL" || key === "REDIS_URL" || key.endsWith("_DATABASE_URL")) delete env[key];
}
for (const [directory, configFile] of suites) {
  const cwd = path.resolve(root, directory);
  const config = JSON.parse(readFileSync(path.join(cwd, configFile), "utf8"));
  const report = path.resolve(cwd, config.jsonReporter?.fileName ?? "reports/mutation/mutation.json");
  process.stdout.write(`\n[mutation] ${directory}/${configFile}\n`);
  const startedAt = Date.now();
  const result = spawnSync("corepack", ["pnpm@11.11.0", "exec", "stryker", "run", configFile], {
    cwd, env, stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
  if (statSync(report).mtimeMs < startedAt) throw new Error(`Mutation report was not refreshed: ${report}`);
}
const disposition = spawnSync(process.execPath, ["scripts/check-mutation-disposition.mjs"], {
  cwd: root, env, stdio: "inherit",
});
if (disposition.error) throw disposition.error;
process.exitCode = disposition.status ?? 1;
