import { afterEach, describe, expect, it, vi } from "vitest";
import type { Kysely } from "kysely";
import type { Database } from "@qianliu/database";
import { buildControlApi } from "../server.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("Control API Origin 集成", () => {
  it("生产环境在进入业务路由前拒绝跨站写请求", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("WEB_ORIGIN", "https://admin.example");
    vi.stubEnv("CREDENTIAL_KEK", "ZGV2LW9ubHkta2VrLXJlcGxhY2UtaW4tcGlsb3QAAAA=");
    vi.stubEnv("COOKIE_SECRET", "test-only-cookie-secret-at-least-32-bytes");
    const app = buildControlApi({} as Kysely<Database>);
    try {
      const blocked = await app.inject({
        method: "POST",
        url: "/auth/login",
        headers: { origin: "https://evil.example" },
        payload: {},
      });
      expect(blocked.statusCode).toBe(403);
      expect(blocked.json()).toMatchObject({ error: "forbidden_origin" });

      const allowed = await app.inject({
        method: "POST",
        url: "/auth/login",
        headers: { origin: "https://admin.example" },
        payload: {},
      });
      expect(allowed.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });
});
