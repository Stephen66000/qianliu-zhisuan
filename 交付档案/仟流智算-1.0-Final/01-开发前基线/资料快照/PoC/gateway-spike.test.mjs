import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { GatewayError, ThinGateway, forecastSupply } from './gateway-spike.mjs';

function fixture(upstream, overrides = {}) {
  return new ThinGateway({
    principals: [{
      id: 'p1',
      key: 'qlk-poc-secret',
      status: 'ACTIVE',
      models: ['qianliu-model'],
      quota: overrides.quota ?? 10_000,
      used: overrides.used ?? 0,
      allowOverage: overrides.allowOverage ?? false,
      concurrency: overrides.concurrency ?? 4,
    }],
    resources: overrides.resources ?? [
      {
        id: 'primary',
        mode: 'PLAN',
        status: 'ACTIVE',
        capabilities: ['chat', 'messages', 'responses'],
        concurrency: 100,
        priority: 1,
        weight: 70,
        errorRate: 0.01,
        ttftMs: 220,
        remaining: 0.3,
        resetAt: '2026-08-01',
        marginalCost: 0,
        multiplier: 2,
        equivalentGroup: 'eq1',
      },
      {
        id: 'backup',
        mode: 'PLAN',
        status: 'ACTIVE',
        capabilities: ['chat', 'messages', 'responses'],
        concurrency: 100,
        priority: 1,
        weight: 30,
        errorRate: 0.005,
        ttftMs: 260,
        remaining: 1,
        resetAt: '2026-08-15',
        marginalCost: 0,
        multiplier: 1,
        equivalentGroup: 'eq1',
      },
    ],
    routes: [{
      model: 'qianliu-model',
      capabilities: ['chat', 'messages', 'responses'],
      resources: ['primary', 'backup'],
    }],
    upstream,
  });
}

const success = (usage = { input: 10, output: 5, cache: 2, quality: 'PROVIDER_REPORTED' }) =>
  async () => ({ status: 200, usage, committed: true, cost: 0 });

function request(id, extra = {}) {
  return {
    id,
    key: 'qlk-poc-secret',
    model: 'qianliu-model',
    capability: 'chat',
    messages: [{ role: 'user', content: extra.canary ?? '正文不落库' }],
    ...extra,
  };
}

test('主体 Key、模型授权和健康资源路由闭环', async () => {
  const gateway = fixture(success());
  const result = await gateway.handle(request('req-auth-route'));
  assert.equal(result.settlement.status, 'SUCCESS');
  assert.equal(gateway.requests.get('req-auth-route').principalId, 'p1');
  assert.equal(gateway.dispatchEvidence[0].candidates.length, 2);
});

test('无效 Key 在访问上游前拒绝', async () => {
  let calls = 0;
  const gateway = fixture(async () => { calls += 1; return { status: 200 }; });
  await assert.rejects(
    gateway.handle(request('req-bad-key', { key: 'wrong' })),
    (error) => error instanceof GatewayError && error.code === 'invalid_principal_key',
  );
  assert.equal(calls, 0);
});

test('未启用能力显式拒绝，不静默降级', async () => {
  const gateway = fixture(success());
  await assert.rejects(
    gateway.handle(request('req-capability', { capability: 'embeddings' })),
    (error) => error.status === 422 && error.code === 'capability_not_supported' && error.details.retryable === false,
  );
});

test('API 与套餐均生成统一 Token 事实，并分别派生费用与扣减', async () => {
  const resources = [
    {
      id: 'api',
      mode: 'API',
      status: 'ACTIVE',
      capabilities: ['chat'],
      concurrency: 10,
      priority: 1,
      weight: 100,
      remaining: 1,
      marginalCost: 0.002,
      multiplier: 1,
    },
  ];
  const gateway = fixture(async () => ({
    status: 200,
    committed: true,
    usage: { input: 20, output: 8, cache: 4, quality: 'PROVIDER_REPORTED' },
    cost: 0.031,
  }), { resources });
  gateway.routes.get('qianliu-model').resources = ['api'];
  const { settlement } = await gateway.handle(request('req-api-billing'));
  assert.deepEqual(settlement.usage, { input: 20, output: 8, cache: 4 });
  assert.equal(settlement.apiCost, 0.031);
  assert.equal(settlement.deduction, 0);
});

test('额度耗尽默认停止且不访问上游', async () => {
  let calls = 0;
  const gateway = fixture(async () => { calls += 1; return { status: 200 }; }, { quota: 100, used: 100 });
  await assert.rejects(gateway.handle(request('req-exhausted')), (error) => error.code === 'principal_quota_exhausted');
  assert.equal(calls, 0);
});

test('允许超额后继续并标记 overage', async () => {
  const gateway = fixture(success({ input: 8, output: 4, cache: 0, quality: 'PROVIDER_REPORTED' }), {
    quota: 100,
    used: 95,
    allowOverage: true,
  });
  const { settlement } = await gateway.handle(request('req-overage'));
  assert.equal(settlement.overage, true);
});

test('重放不重复记账，同一请求只有一个结算汇总', async () => {
  const gateway = fixture(success());
  const first = await gateway.handle(request('req-idempotent'));
  const replay = await gateway.handle(request('req-idempotent'));
  assert.equal(replay.replay, true);
  assert.equal(replay.settlement, first.settlement);
  assert.equal(gateway.settlements.size, 1);
  assert.equal(gateway.ledgerLines.length, 1);
});

test('前序 Attempt 有用量后 429，后序成功，两条明细进入一个汇总', async () => {
  const gateway = fixture(async (resource, _request, attempt) => attempt === 1
    ? {
        status: 429,
        committed: false,
        error: 'rate_limited',
        usage: { input: 10, output: 0, cache: 0, quality: 'ESTIMATED' },
        cost: 0,
      }
    : {
        status: 200,
        committed: true,
        usage: { input: 10, output: 6, cache: 0, quality: 'PROVIDER_REPORTED' },
        cost: 0,
      });
  const { settlement } = await gateway.handle(request('req-two-attempts'));
  assert.equal(settlement.attemptCount, 2);
  assert.deepEqual(settlement.usage, { input: 20, output: 6, cache: 0 });
  assert.equal(settlement.quality, 'MIXED:ESTIMATED+PROVIDER_REPORTED');
  assert.equal(gateway.ledgerLines.length, 2);
});

test('流式提交前故障可切换', async () => {
  const gateway = fixture(async (_resource, _request, attempt) => attempt === 1
    ? { status: 503, committed: false, error: 'upstream_unavailable' }
    : { status: 200, committed: true, usage: { input: 4, output: 2, cache: 0, quality: 'PROVIDER_REPORTED' } });
  const { settlement } = await gateway.handle(request('req-precommit'));
  assert.equal(settlement.status, 'SUCCESS');
  assert.equal(settlement.attemptCount, 2);
});

test('流式提交后故障不得切换或拼接', async () => {
  let calls = 0;
  const gateway = fixture(async () => {
    calls += 1;
    return {
      status: 503,
      committed: true,
      error: 'stream_interrupted',
      usage: { input: 9, output: 0, cache: 0, quality: 'ESTIMATED' },
    };
  });
  const { settlement } = await gateway.handle(request('req-postcommit'));
  assert.equal(settlement.status, 'FAILED');
  assert.equal(settlement.attemptCount, 1);
  assert.equal(calls, 1);
});

test('Affinity 健康时复用，异常时脱离并更新绑定', async () => {
  const chosen = [];
  const gateway = fixture(async (resource) => {
    chosen.push(resource.id);
    return { status: 200, committed: true, usage: { input: 1, output: 1, cache: 0, quality: 'PROVIDER_REPORTED' } };
  });
  await gateway.handle(request('req-affinity-1', { sessionId: 'session-canary' }));
  await gateway.handle(request('req-affinity-2', { sessionId: 'session-canary' }));
  assert.equal(chosen[1], chosen[0]);
  gateway.resources.get(chosen[0]).status = 'CREDENTIAL_INVALID';
  await gateway.handle(request('req-affinity-3', { sessionId: 'session-canary' }));
  assert.notEqual(chosen[2], chosen[0]);
});

test('客户端取消传播到上游并形成取消结算', async () => {
  const controller = new AbortController();
  const gateway = fixture(async (_resource, req) => {
    controller.abort();
    if (req.signal.aborted) {
      const error = new Error('aborted');
      error.name = 'AbortError';
      throw error;
    }
    return { status: 200 };
  });
  const { settlement } = await gateway.handle(request('req-cancel', { signal: controller.signal }));
  assert.equal(settlement.status, 'CANCELLED');
});

test('并发预占阻止同一主体穿透上限', async () => {
  const gateway = fixture(async () => {
    await delay(30);
    return { status: 200, committed: true, usage: { input: 1, output: 1, cache: 0, quality: 'PROVIDER_REPORTED' } };
  }, { concurrency: 1 });
  const first = gateway.handle(request('req-concurrency-1'));
  await assert.rejects(gateway.handle(request('req-concurrency-2')), (error) => error.code === 'principal_concurrency_exceeded');
  await first;
});

test('多窗口速度生成耗尽、恢复、覆盖与可信度', () => {
  const forecast = forecastSupply({
    remaining: 1_040,
    speedsPerDay: [142, 130, 118],
    nextRecoveryAt: '2026-08-10T00:00:00.000Z',
  });
  assert.equal(forecast.confidence, 'HIGH');
  assert.equal(forecast.coverageDays, 8);
  assert.equal(forecast.expectedExhaustionAt, '2026-08-03T00:00:00.000Z');
});

test('高峰只在等价资源间切换并保存可回放节省证据', async () => {
  const gateway = fixture(success({ input: 10, output: 6, cache: 0, quality: 'PROVIDER_REPORTED' }));
  const { settlement } = await gateway.handle(request('req-peak', { highPeak: true }));
  assert.equal(gateway.dispatchEvidence[0].code, 'SWITCH_SCHEDULED');
  assert.equal(settlement.saving, 16);
  assert.equal(gateway.dispatchEvidence[0].candidates.every((candidate) => candidate.factors), true);
});

test('无调度行为或无基线时节省不可计算', async () => {
  const gateway = fixture(success());
  const { settlement } = await gateway.handle(request('req-no-saving'));
  assert.equal(settlement.saving, 'NOT_CALCULABLE');
});

test('100 并发候选请求完成且结算唯一', async () => {
  const gateway = fixture(success({ input: 1, output: 1, cache: 0, quality: 'PROVIDER_REPORTED' }), {
    concurrency: 120,
    quota: 10_000,
  });
  const before = process.memoryUsage().heapUsed;
  const started = performance.now();
  const results = await Promise.all(Array.from({ length: 100 }, (_, index) =>
    gateway.handle(request(`req-load-${index}`))));
  const elapsedMs = performance.now() - started;
  const heapDeltaBytes = process.memoryUsage().heapUsed - before;
  assert.equal(results.every((result) => result.settlement.status === 'SUCCESS'), true);
  assert.equal(gateway.settlements.size, 100);
  assert.ok(elapsedMs < 2_000);
  assert.ok(heapDeltaBytes < 64 * 1024 * 1024);
});

test('正文 canary 在请求、账本、结算、Affinity 与路由证据中命中 0', async () => {
  const canary = 'QIANLIU-CONTENT-CANARY-20260726';
  const gateway = fixture(success());
  await gateway.handle(request('req-canary', { canary, sessionId: `${canary}-session` }));
  assert.equal(gateway.scanCanary(canary), 0);
});

