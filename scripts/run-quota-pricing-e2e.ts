import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { startPostgresContainer } from "../packages/testing/src/postgres-container.js";

async function port() {
  const server = createServer(); await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("port unavailable");
  await new Promise<void>((resolve) => server.close(() => resolve())); return String(address.port);
}
const pg = await startPostgresContainer("quota_pricing_e2e");
try {
  const [apiPort, webPort] = await Promise.all([port(), port()]);
  const child = spawn("corepack", ["pnpm@11.11.0", "--dir", "apps/web", "exec", "playwright", "test", "e2e/quota-pricing.spec.ts"], {
    stdio: "inherit", env: { ...process.env, DATABASE_URL: pg.connectionString,
      E2E_CONTROL_API_PORT: apiPort, E2E_WEB_PORT: webPort, WEB_ORIGIN: `http://127.0.0.1:${webPort}`,
      E2E_BROWSER_CHANNEL: process.env.E2E_BROWSER_CHANNEL ?? "chrome",
      GATEWAY_KEY_PEPPER: randomBytes(32).toString("hex"), CREDENTIAL_KEK: randomBytes(32).toString("base64"),
      COOKIE_SECRET: randomBytes(32).toString("hex"), PROVIDER_FINANCE_MODE: "OFF" },
  });
  process.exitCode = await new Promise<number>((resolve, reject) => {
    child.on("error", reject); child.on("exit", (code) => resolve(code ?? 1));
  });
} finally { await pg.stop(); }
