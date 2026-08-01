import { readFile } from "node:fs/promises";

const gate = JSON.parse(await readFile("V3/仟流智算-质量门禁-v1.0.json", "utf8"));
const report = JSON.parse(await readFile("packages/domain/reports/mutation/mutation.json", "utf8"));
const dispositions = new Map(gate.mutation.survivor_dispositions.map((item) => [item.file, item]));
const violations = [];

for (const [file, data] of Object.entries(report.files)) {
  const survived = data.mutants.filter((mutant) => mutant.status === "Survived").length;
  const noCoverage = data.mutants.filter((mutant) => mutant.status === "NoCoverage").length;
  if (survived + noCoverage === 0) continue;
  const disposition = dispositions.get(file);
  if (!disposition) {
    violations.push(`${file}: ${survived} survived + ${noCoverage} no-coverage 未登记处置`);
    continue;
  }
  for (const field of ["owner", "decision", "reason", "action", "due_on"]) {
    if (!disposition[field]) violations.push(`${file}: 处置缺少 ${field}`);
  }
  if (survived > disposition.max_survived || noCoverage > disposition.max_no_coverage) {
    violations.push(`${file}: 存活变异增长为 ${survived}/${noCoverage}，基线 ${disposition.max_survived}/${disposition.max_no_coverage}`);
  }
}

if (violations.length > 0) {
  console.error(violations.join("\n"));
  process.exitCode = 1;
} else {
  console.log(`mutation disposition gate passed: ${dispositions.size} domain files tracked; worker has 0 survivors`);
}
