import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

const destination = process.argv[2];
if (!destination) throw new Error("用法: node scripts/create-candidate-lock.mjs <输出文件>");

const excludedPrefixes = [
  "_knowledge_base/",
  "V3/Evidence/Final-Audit/",
  "packages/domain/reports/",
  "apps/worker/reports/",
];
const excludedFiles = new Set([
  "V3/Planning-Change-Log.md",
  "V3/仟流智算-stage-state-v0.3.yaml",
]);
const raw = execFileSync("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], { encoding: "utf8" });
const records = raw.split("\0").filter(Boolean);
const entries = [];

for (let index = 0; index < records.length; index += 1) {
  const record = records[index];
  const status = record.slice(0, 2);
  const file = record.slice(3);
  if (status.includes("R") || status.includes("C")) index += 1;
  if (excludedFiles.has(file) || excludedPrefixes.some((prefix) => file.startsWith(prefix))) continue;
  if (/\/(coverage|dist)\//u.test(`/${file}`)) continue;
  if (status.includes("D")) {
    entries.push(`DELETED  ${file}`);
    continue;
  }
  const digest = createHash("sha256").update(await readFile(file)).digest("hex");
  entries.push(`${digest}  ${file}`);
}

entries.sort((left, right) => left.localeCompare(right, "en"));
await writeFile(destination, `${entries.join("\n")}\n`, "utf8");
console.log(`candidate lock written: ${entries.length} entries -> ${destination}`);
