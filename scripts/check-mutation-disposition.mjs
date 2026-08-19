import { readFile } from "node:fs/promises";

const gate = JSON.parse(await readFile("V3/仟流智算-质量门禁-v1.0.json", "utf8"));
const defaultReport = "packages/domain/reports/mutation/mutation.json";
const dispositions = new Map(gate.mutation.survivor_dispositions.map((item) => [
  `${item.report ?? defaultReport}\0${item.file}`,
  item,
]));
const reportPaths = new Set([
  defaultReport,
  "packages/database/reports/mutation/pool043-v22.json",
  ...gate.mutation.survivor_dispositions.flatMap((item) => item.report ? [item.report] : []),
]);
const violations = [];
let timeoutCount = 0;

for (const reportPath of reportPaths) {
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  for (const [file, data] of Object.entries(report.files)) {
    const survived = data.mutants.filter((mutant) => mutant.status === "Survived").length;
    const noCoverage = data.mutants.filter((mutant) => mutant.status === "NoCoverage").length;
    timeoutCount += data.mutants.filter((mutant) => mutant.status === "Timeout").length;
    if (survived + noCoverage === 0) continue;
    const disposition = dispositions.get(`${reportPath}\0${file}`);
    if (!disposition) {
      violations.push(`${reportPath}:${file}: ${survived} survived + ${noCoverage} no-coverage 未登记处置`);
      continue;
    }
    for (const field of ["owner", "decision", "reason", "action", "due_on"]) {
      if (!disposition[field]) violations.push(`${reportPath}:${file}: 处置缺少 ${field}`);
    }
    if (survived > disposition.max_survived || noCoverage > disposition.max_no_coverage) {
      violations.push(`${reportPath}:${file}: 存活变异增长为 ${survived}/${noCoverage}，基线 ${disposition.max_survived}/${disposition.max_no_coverage}`);
    }
  }
}

if (violations.length > 0) {
  console.error(violations.join("\n"));
  process.exitCode = 1;
} else {
  console.log(`mutation disposition gate passed: ${reportPaths.size} reports, ${dispositions.size} files tracked; ${timeoutCount} timeout mutants recorded`);
}
