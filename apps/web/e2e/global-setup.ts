import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

export default function globalSetup(): void {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
  const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  execFileSync(pnpm, ["--filter", "@qianliu/control-api", "seed:e2e"], {
    cwd: root,
    env: process.env,
    stdio: "inherit",
  });
}
