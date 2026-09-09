// Executes the actual release shell script against isolated command doubles, never Docker/SSH.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  chmodSync,
  symlinkSync,
  existsSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
const repo = process.cwd();
const source = "eb1ed123ec8e919cad0e78947c9cd9c441dee352";
const sourceTree = "bb364298d362c22c7628b7f0d36e160563b0deaf";
const scriptPath =
  "deploy/scripts/release-system-settings-20260909-mac-mini.sh";
const original = readFileSync(scriptPath, "utf8");
const candidate =
  original.match(/^candidate=([0-9a-f]{40})$/m)?.[1] ??
  execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
const tree =
  original.match(/^tree=([0-9a-f]{40})$/m)?.[1] ??
  execFileSync("git", ["rev-parse", "HEAD^{tree}"], {
    encoding: "utf8",
  }).trim();
const sourcePaths = execFileSync(
  "git",
  ["ls-tree", "-r", "--name-only", source, "packages/database/migrations"],
  { encoding: "utf8" },
)
  .trim()
  .split("\n");
const sourceNames = sourcePaths.map((p) => path.basename(p, ".js")).sort();
const suiteRoot = realpathSync(
  mkdtempSync(path.join(tmpdir(), "qianliu-settings-release-rehearsal-")),
);
const mock = `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path');
const cmd = path.basename(process.argv[1]), args = process.argv.slice(2), root = process.env.REHEARSAL_ROOT;
const filename = path.join(root, 'state.json'), s = JSON.parse(fs.readFileSync(filename, 'utf8'));
const previous = root + '/releases/previous', scenario = s.scenario;
const save = () => fs.writeFileSync(filename, JSON.stringify(s));
const out = x => process.stdout.write(String(x) + '\\n');
const fail = () => { save(); process.exit(1); };
const event = x => { s.events.push(x); save(); };
if (cmd === 'git') {
  const i = args.indexOf('-C'), dir = i >= 0 ? args[i+1] : process.cwd();
  if (args.includes('rev-parse')) {
    if (args.at(-1) === 'HEAD') out(dir === previous ? (scenario === 'source-mismatch' ? 'bad' : s.source) : s.candidate);
    else out(dir === previous ? s.sourceTree : (scenario === 'tree-mismatch' ? 'bad' : s.tree));
  } else if (args.includes('status')) { if (scenario === 'dirty-source') out(' M source.ts'); }
  else if (args.includes('ls-tree')) out(s.sourcePaths.join('\\n'));
  else if (args.includes('diff')) {
    if (args.includes('--name-status')) out(scenario === 'migration-scope-mismatch' ? 'M\\told-migration.js' : 'A\\tpackages/database/migrations/0071_enterprise_contact_details.js\\nA\\tpackages/database/migrations/0072_admin_roles_security.js');
  } else if (args.includes('checkout')) {
    event('checkout'); fs.mkdirSync(dir + '/deploy', { recursive: true });
    fs.mkdirSync(dir + '/packages/database/migrations', { recursive: true });
    for (const name of ['0071_enterprise_contact_details.js', '0072_admin_roles_security.js']) fs.copyFileSync(s.repo + '/packages/database/migrations/' + name, dir + '/packages/database/migrations/' + name);
  } else if (args.includes('init') || args.includes('fetch') || args.includes('remote')) event('git-write');
  save(); process.exit(0);
}
if (cmd === 'curl') { out(scenario === 'health-fail' && s.current !== previous ? 503 : 200); process.exit(0); }
if (cmd === 'sleep') process.exit(0);
if (cmd !== 'docker') throw Error('unrecognized double');
if (args[0] === 'inspect') {
  const format = args[2], service = args.at(-1).replace('qianliu-zhisuan-', '').replace(/-1$/, '');
  if (format.includes('.State.Running')) out(s.running);
  else if (format.includes('.Config.Labels')) out(s.current + '/deploy');
  else if (format.includes('.State.Health')) out('healthy');
  else if (format.includes('.RestartCount')) out(0);
  else if (format.includes('.Image')) out(s.images[service]);
  else throw Error('inspect format');
} else if (args[0] === 'image' && args[1] === 'inspect') out(s.tags[args.at(-1)]);
else if (args[0] === 'image' && args[1] === 'tag') {
  event('tag'); s.tags[args[3]] = s.tags[args[2]] || args[2];
} else if (args[0] === 'compose') {
  if (args.includes('exec')) {
    if (args.at(-1).includes('pg_dump')) { event('backup'); out('simulated custom dump'); }
    else if (args.at(-1).includes('pg_restore')) { event('backup-validate'); if (scenario === 'backup-fail') fail(); }
    else {
      const sql = fs.readFileSync(0, 'utf8');
      if (sql.includes('kysely_migration')) { out(s.names.join('\\n')); if (scenario === 'history-query-fail' || (scenario === 'post-migration-query-fail' && s.events.includes('migrate'))) fail(); }
      else if (sql.includes('security_version')) { out(s.settings); if (scenario === 'settings-query-fail') fail(); }
      else throw Error('unexpected SQL');
    }
  } else if (args.includes('config')) { /* read-only */ }
  else if (args.includes('build')) {
    event('build'); for (const service of Object.keys(s.images)) s.tags['qianliu-zhisuan-' + service] = 'new-' + service;
    if (scenario === 'build-fail') fail();
  } else if (args.includes('stop')) {
    event('stop'); s.running = false;
    if (scenario === 'stop-partial' && !s.partialFailed) { s.partialFailed = true; fail(); }
  } else if (args.includes('run')) {
    event('migrate'); assertStopped();
    if (scenario === 'migration-fail') fail();
    s.names = [...s.sourceNames, '0071_enterprise_contact_details'];
    if (scenario === 'intermediate-migration-fail') fail();
    s.names.push('0072_admin_roles_security');
    if (scenario === 'migration-committed-fail') fail();
    if (scenario === 'unknown-migration') { s.names.push('9999_unknown'); fail(); }
  } else if (args.includes('up')) {
    const directory = process.cwd().replace(/\\/deploy$/, '');
    event(directory === previous ? 'restore-old' : 'start-new'); s.current = directory; s.running = true;
    for (const service of Object.keys(s.images)) s.images[service] = s.tags['qianliu-zhisuan-' + service];
    if (directory !== previous && scenario === 'settings-written-fail') { s.settings = 1; fail(); }
    if (directory !== previous && scenario === 'settings-query-fail') fail();
    if (directory !== previous && scenario === 'start-fail') fail();
  } else throw Error('unexpected compose ' + args);
} else throw Error('unexpected docker ' + args);
save();
function assertStopped() { if (s.running) throw Error('MIGRATION WHILE RUNNING'); }
`;
const results = [];
for (const scenario of [
  "preflight",
  "source-mismatch",
  "dirty-source",
  "lock-held",
  "migration-history-mismatch",
  "history-query-fail",
  "post-migration-query-fail",
  "tree-mismatch",
  "migration-scope-mismatch",
  "build-fail",
  "backup-fail",
  "stop-partial",
  "migration-fail",
  "intermediate-migration-fail",
  "migration-committed-fail",
  "unknown-migration",
  "start-fail",
  "health-fail",
  "settings-written-fail",
  "settings-query-fail",
  "success",
]) {
  const root = path.join(suiteRoot, scenario),
    previous = root + "/releases/previous";
  mkdirSync(previous + "/deploy", { recursive: true });
  mkdirSync(root + "/bin");
  writeFileSync(previous + "/deploy/.env", "TEST_ONLY=1\nAPP_VERSION=old\n");
  writeFileSync(root + "/qianliu-current-release.txt", previous + "\n");
  const images = Object.fromEntries(
    ["control-api", "gateway", "worker", "web"].map((s) => [s, "old-" + s]),
  );
  writeFileSync(
    root + "/state.json",
    JSON.stringify({
      scenario,
      repo,
      source,
      sourceTree,
      candidate,
      tree,
      sourcePaths,
      sourceNames,
      names: [
        ...sourceNames,
        ...(scenario === "migration-history-mismatch" ? ["9999_unknown"] : []),
      ],
      current: previous,
      images,
      tags: Object.fromEntries(
        Object.entries(images).map(([k, v]) => ["qianliu-zhisuan-" + k, v]),
      ),
      running: true,
      settings: 0,
      events: [],
    }),
  );
  const lock = root + "/.qianliu-quota-pricing-release.lock";
  if (scenario === "lock-held") mkdirSync(lock);
  const mockPath = root + "/bin/mock";
  writeFileSync(mockPath, mock);
  chmodSync(mockPath, 0o755);
  for (const command of ["git", "docker", "curl", "sleep"])
    symlinkSync(mockPath, root + "/bin/" + command);
  const script = original
    .replace("root=/Users/stephen", "root=" + root)
    .replace("candidate=__CANDIDATE__", "candidate=" + candidate)
    .replace("tree=__TREE__", "tree=" + tree);
  writeFileSync(root + "/release.sh", script);
  const run = spawnSync(
    "bash",
    [
      root + "/release.sh",
      scenario === "preflight" ? "--preflight" : "--deploy",
    ],
    {
      env: {
        ...process.env,
        PATH: root + "/bin:" + process.env.PATH,
        REHEARSAL_ROOT: root,
      },
      encoding: "utf8",
      timeout: 25000,
    },
  );
  writeFileSync(root + "/output.log", run.stdout + run.stderr);
  assert.ifError(run.error);
  const state = JSON.parse(readFileSync(root + "/state.json", "utf8"));
  const events = state.events;
  if (["preflight", "success"].includes(scenario))
    assert.equal(
      run.status,
      0,
      scenario + ": " + run.stdout + run.stderr + " logs=" + root,
    );
  else assert.notEqual(run.status, 0, scenario);
  if (scenario === "preflight") {
    assert.deepEqual(events, []);
    assert.equal(existsSync(lock), false);
  }
  if (events.includes("migrate")) {
    assert(events.indexOf("stop") < events.indexOf("backup"), scenario);
    assert(
      events.indexOf("backup") < events.indexOf("backup-validate"),
      scenario,
    );
    assert(
      events.indexOf("backup-validate") < events.indexOf("migrate"),
      scenario,
    );
  }
  if (
    [
      "source-mismatch",
      "dirty-source",
      "lock-held",
      "migration-history-mismatch",
      "history-query-fail",
    ].includes(scenario)
  )
    assert.deepEqual(events, []);
  if (
    [
      "tree-mismatch",
      "migration-scope-mismatch",
      "build-fail",
      "backup-fail",
      "stop-partial",
    ].includes(scenario)
  )
    assert(!events.includes("migrate"));
  if (
    [
      "settings-written-fail",
      "settings-query-fail",
      "unknown-migration",
      "post-migration-query-fail",
    ].includes(scenario)
  ) {
    assert(!events.includes("restore-old"));
    assert.equal(state.running, false);
    assert(existsSync(lock));
  } else if (scenario !== "lock-held")
    assert.equal(existsSync(lock), false, scenario);
  if (
    ![
      "success",
      "settings-written-fail",
      "settings-query-fail",
      "unknown-migration",
      "post-migration-query-fail",
    ].includes(scenario)
  ) {
    assert.equal(state.running, true);
    assert.equal(
      readFileSync(root + "/qianliu-current-release.txt", "utf8").trim(),
      previous,
    );
  }
  if (scenario === "success") {
    assert.equal(state.names.at(-1), "0072_admin_roles_security");
    assert.equal(
      readFileSync(root + "/qianliu-current-release.txt", "utf8").trim(),
      state.current,
    );
    assert(events.indexOf("start-new") > events.indexOf("migrate"));
    assert.equal(
      readFileSync(previous + "/deploy/.env", "utf8"),
      "TEST_ONLY=1\nAPP_VERSION=old\n",
    );
    const newEnv = readFileSync(state.current + "/deploy/.env", "utf8");
    assert(newEnv.includes("TEST_ONLY=1\n"));
    assert.deepEqual(newEnv.match(/^APP_VERSION=.*$/gm), [
      "APP_VERSION=" + candidate,
    ]);
  }
  results.push({ scenario, exit: run.status, result: "PASS", events });
}
console.log(
  JSON.stringify(
    {
      mode: "isolated command doubles; not a real Docker or server deployment",
      suiteRoot,
      results,
    },
    null,
    2,
  ),
);
