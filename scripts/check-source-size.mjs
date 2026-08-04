import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const maxLogicalLines = 400;
const generatedDirectories = new Set([".stryker-tmp", "coverage", "dist", "node_modules", "reports"]);
const gateConfig = JSON.parse(await readFile("V3/仟流智算-质量门禁-v1.0.json", "utf8"));
const legacyBaselines = new Map(
  gateConfig.source_size.exceptions.map((item) => [item.file, item.baseline]),
);
for (const field of ["owner", "reason", "reviewed_on", "review_due", "exit"]) {
  if (!gateConfig.source_size.exception_policy[field]) {
    throw new Error(`source_size.exception_policy 缺少 ${field}`);
  }
}

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return generatedDirectories.has(entry.name) ? [] : walk(target);
    }
    return [target];
  }));
  return nested.flat();
}

function countLogicalLines(source) {
  return source.split(/\r?\n/u).filter((line) => {
    const trimmed = line.trim();
    return trimmed.length > 0
      && !trimmed.startsWith("//")
      && !trimmed.startsWith("/*")
      && !trimmed.startsWith("*")
      && !trimmed.startsWith("*/");
  }).length;
}

const files = (await Promise.all([walk("apps"), walk("packages")])).flat()
  .filter((file) => /\/src\/.*\.tsx?$/u.test(file))
  .filter((file) => !/__tests|\.test\./u.test(file));
const violations = [];

for (const file of files) {
  const logicalLines = countLogicalLines(await readFile(file, "utf8"));
  const baseline = legacyBaselines.get(file);
  if (logicalLines > maxLogicalLines && baseline === undefined) {
    violations.push(`${file}: ${logicalLines} logical lines，未登记例外`);
  } else if (baseline !== undefined && logicalLines > baseline) {
    violations.push(`${file}: ${logicalLines} logical lines，超过遗留基线 ${baseline}`);
  }
}

if (violations.length > 0) {
  console.error(violations.join("\n"));
  process.exitCode = 1;
} else {
  console.log(`source-size gate passed: ${files.length} files, default <= ${maxLogicalLines} logical lines`);
}
