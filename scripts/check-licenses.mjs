const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const licenses = JSON.parse(Buffer.concat(chunks).toString("utf8"));
const allowed = new Set(["Apache-2.0", "BSD-3-Clause", "BlueOak-1.0.0", "ISC", "MIT", "Unlicense"]);
const denied = Object.keys(licenses).filter((license) => !allowed.has(license));

if (denied.length > 0) {
  console.error(`生产依赖出现未批准许可证: ${denied.join(", ")}`);
  process.exitCode = 1;
} else {
  console.log(`license gate passed: ${Object.keys(licenses).sort().join(", ")}`);
}
