import { createServer, type Socket } from "node:net";
import { expect, it } from "vitest";
import type { Kysely } from "kysely";
import type { Database } from "@qianliu/database";
import { runInfrastructureChecks } from "./infrastructure-checks.js";

// Small RESP peer exercises the real redis package/socket, not a mocked pingRedis.
function frame(buffer: string): { args: string[]; end: number } | null {
  const header = buffer.indexOf("\r\n");
  if (header < 0) return null;
  const count = Number(buffer.slice(1, header));
  let cursor = header + 2;
  const args: string[] = [];
  for (let i = 0; i < count; i++) {
    const lengthEnd = buffer.indexOf("\r\n", cursor);
    if (lengthEnd < 0) return null;
    const length = Number(buffer.slice(cursor + 1, lengthEnd)),
      start = lengthEnd + 2;
    if (buffer.length < start + length + 2) return null;
    args.push(buffer.slice(start, start + length));
    cursor = start + length + 2;
  }
  return { args, end: cursor };
}
it.each(["PONG", "ERROR", "SILENT"] as const)(
  "real Redis connection handles %s and closes every socket",
  async (mode) => {
    const sockets = new Set<Socket>(),
      commands: string[][] = [];
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      let buffered = "";
      socket.on("data", (data) => {
        buffered += data.toString();
        for (let parsed = frame(buffered); parsed; parsed = frame(buffered)) {
          buffered = buffered.slice(parsed.end);
          commands.push(parsed.args);
          if (parsed.args[0]?.toUpperCase() === "PING") {
            if (mode === "PONG") socket.write("+PONG\r\n");
            if (mode === "ERROR") socket.write("-ERR health failed\r\n");
          } else socket.write("+OK\r\n");
        }
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string")
      throw Error("missing TCP address");
    const results: Array<[string, boolean]> = [];
    const observe = async <T>(
      task: string,
      _title: string,
      work: () => Promise<T>,
    ): Promise<T> => {
      // This fixture has no database. Its probe is tested separately with SQL assertions.
      if (task === "health:database") throw new Error("DB_OUT_OF_SCOPE");
      try {
        const result = await work();
        results.push([task, true]);
        return result;
      } catch (error) {
        results.push([task, false]);
        throw error;
      }
    };
    try {
      const started = Date.now();
      await runInfrastructureChecks({
        db: {} as Kysely<Database>,
        observe,
        env: {
          NODE_ENV: "production",
          REDIS_URL: "redis://127.0.0.1:" + address.port,
        },
        fetch: async () => new Response("ok"),
      });
      expect(results).toContainEqual(["health:redis", mode === "PONG"]);
      expect(commands.some((args) => args[0] === "PING")).toBe(true);
      expect(Date.now() - started).toBeLessThan(5000);
      // Let the peer observe FIN/RST before inspecting owned sockets.
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(sockets.size).toBe(0);
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
  10000,
);
