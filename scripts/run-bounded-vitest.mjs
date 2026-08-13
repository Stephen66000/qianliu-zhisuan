#!/usr/bin/env node

import { spawnSync } from "node:child_process";

const databaseVariables = [
  "DATABASE_URL",
  "REDIS_URL",
  "POOL043_CONTROL_DATABASE_URL",
  "POOL043_GATEWAY_SETTLEMENT_DATABASE_URL",
  "POOL043_W05_DATABASE_URL",
  "POOL043_W07_DATABASE_URL",
  "POOL043_MIGRATION_DATABASE_URL",
  "POOL043_ACCOUNT_DATABASE_URL",
  "POOL043_CONCURRENCY_DATABASE_URL",
  "POOL046_MIGRATION_DATABASE_URL",
  "W20_DEPARTMENT_DATABASE_URL",
];

const env = { ...process.env, CI: "1" };
for (const name of databaseVariables) delete env[name];

const commands = [
  {
    name: "01-non-web-vitest",
    args: [
      "pnpm@11.11.0", "-r", "--workspace-concurrency=1", "--no-bail",
      "--filter", "./apps/**", "--filter", "./packages/**", "--filter", "!@qianliu/web",
      "exec", "vitest", "run", "--config", "../../vitest.config.ts",
      "--no-file-parallelism", "--maxWorkers=1", "--maxConcurrency=1",
    ],
  },
  {
    name: "02-web-tsx",
    args: [
      "pnpm@11.11.0", "--dir", "apps/web", "exec", "vitest", "run",
      "--config", "vitest.config.ts", "--no-file-parallelism", "--maxWorkers=1",
      "--maxConcurrency=1",
    ],
  },
];

for (const command of commands) {
  const quotedCommand = ["corepack", ...command.args]
    .map((part) => JSON.stringify(part))
    .join(" ");
  process.stdout.write(`\n[bounded-test] ${command.name}: ${quotedCommand}\n`);
  const result = spawnSync("corepack", command.args, {
    cwd: process.cwd(),
    env,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
