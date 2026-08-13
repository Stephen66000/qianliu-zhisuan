import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, readFile, readlink, writeFile } from "node:fs/promises";
import path from "node:path";

const args = process.argv.slice(2);
const draft = args.includes("--draft");
const positional = args.filter((arg) => arg !== "--draft");
const destinationArg = positional[0];
if (!destinationArg || positional.length !== 1) {
  throw new Error("用法: node scripts/create-candidate-lock.mjs <输出文件> [--draft]");
}

function git(args, options = {}) {
  return execFileSync("git", args, { encoding: "utf8", ...options });
}

function optionalGit(args) {
  try {
    return git(args, { stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
  } catch {
    return null;
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function hashPath(file) {
  const stat = await lstat(file);
  if (stat.isSymbolicLink()) return sha256(`symlink:${await readlink(file)}`);
  return sha256(await readFile(file));
}

async function collectFiles(directory) {
  const files = [];
  async function visit(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile() || entry.isSymbolicLink()) files.push(absolute);
    }
  }
  try {
    await visit(directory);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return files.sort((left, right) => left.localeCompare(right, "en"));
}

async function fileManifest(root, files, excluded = new Set()) {
  const entries = [];
  for (const absolute of files) {
    const relative = path.relative(root, absolute).split(path.sep).join("/");
    if (excluded.has(relative)) continue;
    entries.push({ path: relative, sha256: await hashPath(absolute) });
  }
  return entries;
}

async function namedManifest(worktreeRoot, authorityRoot, files) {
  const entries = [];
  for (const file of files) {
    let absolute = path.join(worktreeRoot, file);
    let source = "worktree";
    try {
      await lstat(absolute);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      absolute = path.join(authorityRoot, file);
      source = "authority_worktree";
    }
    entries.push({ path: file, source, sha256: await hashPath(absolute) });
  }
  return entries;
}

function parseStatus(raw, excludedPath) {
  const records = raw.split("\0").filter(Boolean);
  const entries = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    const status = record.slice(0, 2);
    const file = record.slice(3);
    const originalPath = status.includes("R") || status.includes("C")
      ? records[++index]
      : null;
    if (file === excludedPath) continue;
    entries.push({ path: file, status, originalPath });
  }
  return entries.sort((left, right) => left.path.localeCompare(right.path, "en"));
}

const root = git(["rev-parse", "--show-toplevel"]).trim();
const commonDirRaw = git(["rev-parse", "--git-common-dir"]).trim();
const commonDir = path.resolve(root, commonDirRaw);
const authorityRoot = path.dirname(commonDir);
const destination = path.resolve(root, destinationArg);
const destinationRelative = path.relative(root, destination).split(path.sep).join("/");
if (destinationRelative.startsWith("../") || destinationRelative === "..") {
  throw new Error("候选锁输出必须位于当前 Git worktree 内");
}

const status = parseStatus(
  git(["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
  destinationRelative,
);
if (status.length > 0 && !draft) {
  throw new Error(`最终候选锁要求干净 worktree；当前有 ${status.length} 个未冻结路径。仅取证草案可追加 --draft`);
}

const dirtyEntries = [];
for (const entry of status) {
  const absolute = path.join(root, entry.path);
  dirtyEntries.push({
    ...entry,
    sha256: entry.status.includes("D") ? null : await hashPath(absolute),
  });
}

const migrationFiles = (await collectFiles(path.join(root, "packages/database/migrations")))
  .filter((file) => file.endsWith(".js"));
const migrationManifest = await fileManifest(root, migrationFiles);
const evidenceFiles = await collectFiles(path.join(root, "V4/Evidence"));
const evidenceManifest = await fileManifest(root, evidenceFiles, new Set([destinationRelative]));

const configurationPaths = [
  ".env.example",
  "deploy/compose.yaml",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
];
const trackedAndUntracked = git(["ls-files", "-co", "--exclude-standard", "-z"])
  .split("\0").filter(Boolean);
for (const file of trackedAndUntracked) {
  if (file.endsWith("Dockerfile")) configurationPaths.push(file);
}
const configurationManifest = await fileManifest(
  root,
  [...new Set(configurationPaths)].sort().map((file) => path.join(root, file)),
);

const frozenInputPaths = [
  "V4/仟流智算-开发执行基线-v2.0.yaml",
  "V4/仟流智算-开发规划-v2.0.md",
  "V4/仟流智算-项目工程规则-v2.0.md",
  "V4/仟流智算-产品需求文档-v2.0.md",
  "V4/仟流智算-技术需求文档-v2.0.md",
  "V4/仟流智算-初始验收矩阵-v2.0.md",
  "V4/原型/仟流智算-2.0-标准版原型.html",
];
const frozenInputs = await namedManifest(root, authorityRoot, frozenInputPaths);
const branch = optionalGit(["symbolic-ref", "--quiet", "--short", "HEAD"]);
const head = git(["rev-parse", "HEAD"]).trim();
const tree = git(["rev-parse", "HEAD^{tree}"]).trim();
const treeManifestSha256 = sha256(git(["ls-tree", "-r", "-z", "--full-tree", "HEAD"]));
const migrationManifestSha256 = sha256(JSON.stringify(migrationManifest));
const evidenceManifestSha256 = sha256(JSON.stringify(evidenceManifest));
const configurationManifestSha256 = sha256(JSON.stringify(configurationManifest));
const frozenInputsSha256 = sha256(JSON.stringify(frozenInputs));
const dirtyManifestSha256 = sha256(JSON.stringify(dirtyEntries));

const fingerprintPayload = {
  head,
  tree,
  dirty: status.length > 0,
  dirtyManifestSha256,
  treeManifestSha256,
  migrationHead: path.basename(migrationFiles.at(-1) ?? "", ".js"),
  migrationManifestSha256,
  configurationManifestSha256,
  frozenInputsSha256,
  evidenceManifestSha256,
};
const result = {
  schema_version: "qianliu-candidate-lock/v2",
  lock_status: draft ? "draft_dirty" : "final",
  generated_at: new Date().toISOString(),
  repository: {
    worktree: root,
    authority_worktree: authorityRoot,
    head,
    tree,
    branch,
    detached_head: branch === null,
    dirty: status.length > 0,
    dirty_path_count: status.length,
    dirty_manifest_sha256: dirtyManifestSha256,
    dirty_entries: dirtyEntries,
    tree_manifest_sha256: treeManifestSha256,
  },
  migration: {
    head: fingerprintPayload.migrationHead,
    count: migrationManifest.length,
    manifest_sha256: migrationManifestSha256,
    files: migrationManifest,
  },
  configuration: {
    manifest_sha256: configurationManifestSha256,
    files: configurationManifest,
  },
  frozen_inputs: {
    manifest_sha256: frozenInputsSha256,
    files: frozenInputs,
  },
  evidence: {
    root: "V4/Evidence",
    generated_lock_excluded: destinationRelative,
    file_count: evidenceManifest.length,
    manifest_sha256: evidenceManifestSha256,
  },
  fingerprint: {
    algorithm: "sha256(JSON.stringify(payload))",
    value: sha256(JSON.stringify(fingerprintPayload)),
    payload: fingerprintPayload,
  },
};

await mkdir(path.dirname(destination), { recursive: true });
await writeFile(destination, `${JSON.stringify(result, null, 2)}\n`, "utf8");
console.log(`candidate lock ${result.lock_status}: ${result.fingerprint.value} -> ${destinationRelative}`);
