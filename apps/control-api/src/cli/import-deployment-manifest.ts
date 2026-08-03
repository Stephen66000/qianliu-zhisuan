import { readFile } from "node:fs/promises";
import { createKysely, DeploymentLogRepository } from "@qianliu/database";
import {
  DeploymentManifestSchema,
  isSafeDeploymentManifest,
} from "../deployment-logs/routes.js";

const args = process.argv.slice(2);
const value = (name: string) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};

const enterpriseId = value("--enterprise");
const file = value("--file");
if (!enterpriseId || !file) throw new Error("需要 --enterprise 与 --file");
const raw = JSON.parse(await readFile(file, "utf8")) as unknown;
const parsed = DeploymentManifestSchema.safeParse(raw);
if (!parsed.success) throw new Error("Manifest 格式无效");
if (!isSafeDeploymentManifest(parsed.data)) throw new Error("Manifest 含敏感信息或未批准路径");

const db = createKysely();
try {
  const deployment = await new DeploymentLogRepository(db).importManifest(enterpriseId, {
    ...parsed.data,
    startedAt: new Date(parsed.data.startedAt),
    finishedAt: parsed.data.finishedAt ? new Date(parsed.data.finishedAt) : null,
  });
  console.log(JSON.stringify({
    event: "deployment_manifest_imported",
    deployment_id: deployment.deployment_id,
    status: deployment.status,
    record_id: deployment.id,
  }));
} finally {
  await db.destroy();
}
