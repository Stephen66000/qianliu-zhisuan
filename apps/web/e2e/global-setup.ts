import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

export default async function globalSetup(): Promise<void> {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
  const tsxCli = fileURLToPath(import.meta.resolve("tsx/cli"));
  const seedScript = path.join(root, "apps/control-api/src/cli/seed-e2e.ts");
  execFileSync(process.execPath, [tsxCli, seedScript], {
    cwd: root,
    env: process.env,
    stdio: "inherit",
  });
  if (process.env.E2E_UPSTREAM_ORIGIN) {
    const { seedLocalUpstreamCredentials } = await import("./seed-local-upstream-credentials");
    await seedLocalUpstreamCredentials();
  }
}
