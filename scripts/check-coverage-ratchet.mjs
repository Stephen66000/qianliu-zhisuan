import { readFile } from "node:fs/promises";

const config = JSON.parse(await readFile("V3/仟流智算-质量门禁-v1.0.json", "utf8"));
const violations = [];

for (const item of config.coverage.ratchets) {
  let report;
  try {
    report = JSON.parse(await readFile(item.report, "utf8"));
  } catch (error) {
    violations.push(`${item.scope}: 缺少覆盖率报告 ${item.report}（${error.code ?? "read_error"}）`);
    continue;
  }
  for (const metric of ["statements", "branches", "functions", "lines"]) {
    const actual = report.total?.[metric]?.pct;
    const baseline = item.minimum[metric];
    if (typeof actual !== "number" || actual + 0.001 < baseline) {
      violations.push(`${item.scope}: ${metric} ${actual ?? "missing"}% < 防下降基线 ${baseline}%`);
    }
  }
}

if (violations.length > 0) {
  console.error(violations.join("\n"));
  process.exitCode = 1;
} else {
  console.log(`coverage ratchet passed: ${config.coverage.ratchets.length} scopes did not regress`);
}
