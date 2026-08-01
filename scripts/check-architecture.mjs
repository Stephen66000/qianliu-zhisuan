import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";

const root = process.cwd();

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const target = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(target) : [target];
  }));
  return nested.flat();
}

const relativeFiles = (await Promise.all([walk("apps"), walk("packages")])).flat()
  .filter((file) => /\/src\/.*\.tsx?$/u.test(file))
  .filter((file) => !/__tests|\.test\./u.test(file));
const files = new Set(relativeFiles.map((file) => path.resolve(root, file)));
const packageRoots = new Map();

for (const directory of ["apps", "packages"]) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const packageRoot = path.resolve(root, directory, entry.name);
    const manifest = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
    if (typeof manifest.name === "string") packageRoots.set(manifest.name, packageRoot);
  }
}

function runtimeSpecifiers(source, fileName) {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const specifiers = [];
  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      const clause = statement.importClause;
      const named = clause?.namedBindings;
      const typeOnly = clause?.isTypeOnly === true
        || (clause && !clause.name && named && ts.isNamedImports(named)
          && named.elements.every((element) => element.isTypeOnly));
      if (!typeOnly) specifiers.push(statement.moduleSpecifier.text);
    }
    if (ts.isExportDeclaration(statement) && statement.moduleSpecifier
      && ts.isStringLiteral(statement.moduleSpecifier) && !statement.isTypeOnly) {
      specifiers.push(statement.moduleSpecifier.text);
    }
  }
  const visit = (node) => {
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword
      && node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0])) {
      specifiers.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return specifiers;
}

function resolveSource(importer, specifier) {
  let candidate;
  if (specifier.startsWith(".")) {
    candidate = path.resolve(path.dirname(importer), specifier);
  } else {
    const packageName = specifier.startsWith("@")
      ? specifier.split("/").slice(0, 2).join("/")
      : specifier.split("/")[0];
    const packageRoot = packageRoots.get(packageName);
    if (!packageRoot) return undefined;
    const subpath = specifier.slice(packageName.length).replace(/^\//u, "");
    candidate = subpath ? path.join(packageRoot, "src", subpath) : path.join(packageRoot, "src", "index");
  }
  candidate = candidate.replace(/\.js$/u, "");
  for (const suffix of [".ts", ".tsx", "/index.ts", "/index.tsx"]) {
    const resolved = `${candidate}${suffix}`;
    if (files.has(resolved)) return resolved;
  }
  return undefined;
}

const graph = new Map();
const violations = [];
for (const file of files) {
  const source = await readFile(file, "utf8");
  const targets = runtimeSpecifiers(source, file).map((specifier) => resolveSource(file, specifier)).filter(Boolean);
  graph.set(file, targets);
  if (file.includes(`${path.sep}packages${path.sep}`)) {
    for (const target of targets) {
      if (target.includes(`${path.sep}apps${path.sep}`)) {
        violations.push(`共享包禁止运行时反向依赖应用: ${path.relative(root, file)} -> ${path.relative(root, target)}`);
      }
    }
  }
}

const visiting = new Set();
const visited = new Set();
const stack = [];
function visit(file) {
  if (visiting.has(file)) {
    const start = stack.indexOf(file);
    violations.push(`运行时依赖环: ${[...stack.slice(start), file].map((item) => path.relative(root, item)).join(" -> ")}`);
    return;
  }
  if (visited.has(file)) return;
  visiting.add(file);
  stack.push(file);
  for (const target of graph.get(file) ?? []) visit(target);
  stack.pop();
  visiting.delete(file);
  visited.add(file);
}
for (const file of files) visit(file);

if (violations.length > 0) {
  console.error([...new Set(violations)].join("\n"));
  process.exitCode = 1;
} else {
  console.log(`architecture gate passed: ${files.size} production source files, no runtime cycles`);
}
