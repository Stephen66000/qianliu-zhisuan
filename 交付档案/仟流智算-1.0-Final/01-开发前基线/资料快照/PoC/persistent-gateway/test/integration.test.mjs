import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { createPersistentGateway } from '../src/app.mjs';
import { loadProviderConnection, providerInjectionStatus } from '../src/provider-secrets.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const principalKey = 'qlk-poc-secret-never-store';
const pepper = 'poc-pepper-never-store';
const databaseUrl = process.env.DATABASE_URL ?? 'postgresql://qianliu_poc:qianliu_poc_only@127.0.0.1:55437/qianliu_poc';
const redisUrl = process.env.REDIS_URL ?? 'redis://127.0.0.1:56379';
const runtimeDir = await mkdtemp(join(tmpdir(), 'qianliu-gateway-poc-'));
const logPath = join(runtimeDir, 'gateway.jsonl');
let app;
let upstreamCalls = 0;

function auth(extra = {}) {
  return {
    authorization: `Bearer ${principalKey}`,
    ...extra,
  };
}

before(async () => {
  app = await createPersistentGateway({
    databaseUrl,
    redisUrl,
    schemaPath: resolve(root, 'schema.sql'),
    logPath,
    principalKey,
    pepper,
    upstream: async () => {
      upstreamCalls += 1;
      return {
        status: 200,
        committed: true,
        usage: { input: 11, output: 7, cache: 0, quality: 'PROVIDER_REPORTED' },
        cost: 0.000018,
      };
    },
  });
  await app.store.reset();
});

after(async () => {
  await app?.close();
});

test('PostgreSQL 与 Redis 健康检查通过', async () => {
  assert.deepEqual(await app.store.health(), { postgres: true, redis: true });
});

test('DeepSeek、智谱、Kimi 凭证只从环境注入且序列化强制脱敏', () => {
  const env = {
    DEEPSEEK_API_KEY: 'deepseek-secret-canary',
    ZHIPU_CODING_TOKEN: 'zhipu-secret-canary',
    ZHIPU_CODING_BASE_URL: 'https://zhipu.invalid',
    KIMI_CODING_TOKEN: 'kimi-secret-canary',
    KIMI_CODING_BASE_URL: 'https://kimi.invalid',
  };
  const connections = ['deepseek', 'zhipu', 'kimi'].map((name) => loadProviderConnection(name, env));
  assert.equal(connections.every((item) => item.configured), true);
  assert.deepEqual(
    providerInjectionStatus(env).map(({ name, configured }) => ({ name, configured })),
    [
      { name: 'deepseek', configured: true },
      { name: 'zhipu', configured: true },
      { name: 'kimi', configured: true },
    ],
  );
  const serialized = JSON.stringify(connections);
  assert.equal(serialized.includes('deepseek-secret-canary'), false);
  assert.equal(serialized.includes('zhipu-secret-canary'), false);
  assert.equal(serialized.includes('kimi-secret-canary'), false);
});

test('无效主体 Key 在上游前拒绝', async () => {
  const beforeCalls = upstreamCalls;
  const result = await app.handleHttp({
    method: 'GET',
    path: '/v1/models',
    headers: { authorization: 'Bearer invalid' },
  });
  assert.equal(result.status, 401);
  assert.equal(upstreamCalls, beforeCalls);
});

test('Models 北向合同可调用', async () => {
  const result = await app.handleHttp({
    method: 'GET',
    path: '/v1/models',
    headers: auth(),
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.data[0].id, 'qianliu-model');
});

test('OpenAI Chat 合同完成持久化闭环', async () => {
  const result = await app.handleHttp({
    method: 'POST',
    path: '/v1/chat/completions',
    headers: auth({ 'x-request-id': 'poc-http-chat-01', 'x-session-id': 'session-sensitive-01' }),
    body: {
      model: 'qianliu-model',
      messages: [{ role: 'user', content: 'CANARY_BODY_CHAT_7f0b' }],
    },
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.qianliu.request_id, 'poc-http-chat-01');
  assert.deepEqual(result.body.usage, {
    prompt_tokens: 11,
    completion_tokens: 7,
    total_tokens: 18,
  });
});

test('Anthropic Messages 合同完成持久化闭环', async () => {
  const result = await app.handleHttp({
    method: 'POST',
    path: '/v1/messages',
    headers: auth({ 'x-request-id': 'poc-http-messages-01' }),
    body: {
      model: 'qianliu-model',
      messages: [{ role: 'user', content: 'CANARY_BODY_MESSAGES_8a1c' }],
    },
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.type, 'message');
  assert.deepEqual(result.body.usage, { input_tokens: 11, output_tokens: 7 });
});

test('未启用端点显式返回 422，不静默降级', async () => {
  const result = await app.handleHttp({
    method: 'POST',
    path: '/v1/responses',
    headers: auth(),
    body: { model: 'qianliu-model', input: 'not-stored' },
  });
  assert.equal(result.status, 422);
  assert.equal(result.body.error.type, 'capability_not_supported');
});

test('相同 request-id 跨调用幂等，上游与结算各一次', async () => {
  const beforeCalls = upstreamCalls;
  const request = {
    method: 'POST',
    path: '/v1/chat/completions',
    headers: auth({ 'x-request-id': 'poc-idempotent-01' }),
    body: { model: 'qianliu-model', messages: [{ role: 'user', content: 'not-stored-idempotent' }] },
  };
  const first = await app.handleHttp(request);
  const second = await app.handleHttp(request);
  assert.equal(first.status, 200);
  assert.equal(second.body.qianliu.replay, true);
  assert.equal(upstreamCalls - beforeCalls, 1);
  const count = await app.store.pool.query(
    'SELECT count(*)::int AS count FROM gateway_settlements WHERE request_id = $1',
    ['poc-idempotent-01'],
  );
  assert.equal(count.rows[0].count, 1);
});

test('数据库只保存元数据、Attempt 与唯一结算', async () => {
  const rows = await app.store.pool.query(
    `SELECT
       (SELECT count(*)::int FROM gateway_requests) AS requests,
       (SELECT count(*)::int FROM gateway_attempts) AS attempts,
       (SELECT count(*)::int FROM gateway_settlements) AS settlements,
       (SELECT count(*)::int FROM gateway_dispatches) AS dispatches`,
  );
  assert.deepEqual(rows.rows[0], {
    requests: 3,
    attempts: 3,
    settlements: 3,
    dispatches: 3,
  });
});

test('正文、主体明文 Key 与 Session 明文在 PostgreSQL/Redis/日志/Trace 均为 0 命中', async () => {
  for (const canary of [
    'CANARY_BODY_CHAT_7f0b',
    'CANARY_BODY_MESSAGES_8a1c',
    principalKey,
    'session-sensitive-01',
  ]) {
    assert.deepEqual(await app.scanCanary(canary), {
      postgres: 0,
      redis: 0,
      logs: 0,
      traces: 0,
    });
  }
});

test('PostgreSQL 结算可在 Redis 缓存清除后恢复', async () => {
  await app.store.redis.del('gateway:idem:poc-http-chat-01');
  const restored = await app.store.getSettlement('poc-http-chat-01');
  assert.equal(restored.status, 'SUCCESS');
  assert.equal(restored.requestId, 'poc-http-chat-01');
  assert.equal(restored.attemptCount, 1);
});

test('JSONL 日志与 OTel Trace 只含白名单元数据', async () => {
  const logText = await app.logger.text();
  assert.match(logText, /gateway\.request\.completed/);
  assert.match(logText, /poc-http-chat-01/);
  const spans = app.tracing.exporter.getFinishedSpans();
  assert.equal(spans.length >= 3, true);
  assert.equal(spans.every((span) => !('gateway.body' in span.attributes)), true);
});
