import { readFileSync } from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { requireAuth } from "../plugins/auth-guard.js";

/**
 * 解析产品版本号：环境变量 APP_VERSION 优先（部署覆盖），
 * 否则读取仓库根目录 VERSION 文件（权威来源，见 I1 审核 F-P3-5 关闭记录）。
 * 从 startDir 向上最多回溯 6 级查找 VERSION；均不可得时返回 null。
 */
export function resolveAppVersion(
  env: NodeJS.ProcessEnv = process.env,
  startDir: string = process.cwd(),
): string | null {
  const fromEnv = env.APP_VERSION?.trim();
  if (fromEnv) return fromEnv;
  let dir = path.resolve(startDir);
  for (let depth = 0; depth < 6; depth += 1) {
    try {
      const content = readFileSync(path.join(dir, "VERSION"), "utf8").trim();
      if (/^\d+\.\d+\.\d+[-+.\w]*$/u.test(content)) return content;
    } catch {
      // 本级没有 VERSION 或不可读，继续向上查找
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

export function registerVersionRoute(app: FastifyInstance) {
  const version = resolveAppVersion();
  app.get("/system-version", { preHandler: [requireAuth] }, async req => {
    const releases = await app.db.selectFrom("deployment_log")
      .select(["id", "from_version", "to_version", "status", "started_at", "finished_at", "summary"])
      .where("enterprise_id", "=", req.admin!.enterpriseId).orderBy("started_at", "desc").limit(30).execute();
    return { product: "仟流智算", version, releases };
  });
}
