import { spawnSync } from 'node:child_process';

const startedAt = new Date().toISOString();
const started = performance.now();
const result = spawnSync(process.execPath, ['--test', 'gateway-spike.test.mjs'], {
  cwd: new URL('.', import.meta.url),
  encoding: 'utf8',
});
const elapsedMs = Number((performance.now() - started).toFixed(3));

const summary = {
  poc: 'POC-03',
  startedAt,
  finishedAt: new Date().toISOString(),
  runtime: process.version,
  elapsedMs,
  exitCode: result.status,
  stdout: result.stdout,
  stderr: result.stderr,
};

process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
process.exitCode = result.status ?? 1;
