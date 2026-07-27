import { ThinGateway } from './gateway-spike.mjs';

const gateway = new ThinGateway({
  principals: [{
    id: 'p-load',
    key: 'qlk-load',
    status: 'ACTIVE',
    models: ['qianliu-load'],
    quota: 100_000,
    concurrency: 120,
  }],
  resources: [{
    id: 'load-resource',
    mode: 'PLAN',
    status: 'ACTIVE',
    capabilities: ['chat'],
    concurrency: 120,
    priority: 1,
    weight: 100,
    remaining: 1,
    multiplier: 1,
  }],
  routes: [{
    model: 'qianliu-load',
    capabilities: ['chat'],
    resources: ['load-resource'],
  }],
  upstream: async () => ({
    status: 200,
    committed: true,
    usage: { input: 1, output: 1, cache: 0, quality: 'PROVIDER_REPORTED' },
  }),
});

const before = process.memoryUsage();
const cpuBefore = process.cpuUsage();
const started = performance.now();
const results = await Promise.all(Array.from({ length: 100 }, (_, index) => gateway.handle({
  id: `bench-${index}`,
  key: 'qlk-load',
  model: 'qianliu-load',
  capability: 'chat',
})));
const elapsedMs = performance.now() - started;
const cpu = process.cpuUsage(cpuBefore);
const after = process.memoryUsage();

process.stdout.write(`${JSON.stringify({
  concurrency: 100,
  success: results.filter((result) => result.settlement.status === 'SUCCESS').length,
  uniqueSettlements: gateway.settlements.size,
  elapsedMs: Number(elapsedMs.toFixed(3)),
  cpuUserMs: Number((cpu.user / 1000).toFixed(3)),
  cpuSystemMs: Number((cpu.system / 1000).toFixed(3)),
  heapDeltaBytes: after.heapUsed - before.heapUsed,
  rssDeltaBytes: after.rss - before.rss,
  runtime: process.version,
}, null, 2)}\n`);
