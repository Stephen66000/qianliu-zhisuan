const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const licenses = JSON.parse(Buffer.concat(chunks).toString("utf8"));
const allowed = new Set([
  "Apache-2.0", "BSD-3-Clause", "BlueOak-1.0.0", "ISC", "MIT", "MIT/X11", "Unlicense",
  "(MIT OR GPL-3.0-or-later)", "(MIT AND Zlib)",
]);
// buffers@0.1.1 的发布包缺少 license 字段；Debian 溯源核验为 MIT：
// https://sources.debian.org/copyright/license/node-buffers/0.1.1-2/
// 仅按已核验的包名和版本放行，不扩大 Unknown。
const allowedUnknownPackages = new Map([["buffers", new Set(["0.1.1"])]]);
const unknownPackagesApproved = (entries) => Array.isArray(entries) && entries.every((entry) => {
  const versions = allowedUnknownPackages.get(entry.name);
  return versions && Array.isArray(entry.versions) && entry.versions.length > 0
    && entry.versions.every((version) => versions.has(version));
});
const denied = Object.keys(licenses).filter((license) => !allowed.has(license)
  && !(license === "Unknown" && unknownPackagesApproved(licenses[license])));

if (denied.length > 0) {
  console.error(`生产依赖出现未批准许可证: ${denied.join(", ")}`);
  process.exitCode = 1;
} else {
  console.log(`license gate passed: ${Object.keys(licenses).sort().join(", ")}`);
}
