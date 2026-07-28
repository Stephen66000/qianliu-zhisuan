import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

export default function globalSetup(): void {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
  const tsxCli = fileURLToPath(import.meta.resolve("tsx/cli"));
  const seedScript = path.join(root, "apps/control-api/src/cli/seed-e2e.ts");
  execFileSync(process.execPath, [tsxCli, seedScript], {
    cwd: root,
    env: process.env,
    stdio: "inherit",
  });
}
