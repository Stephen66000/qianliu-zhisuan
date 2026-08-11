import { createHmac, randomUUID } from 'node:crypto';
import { GatewayError, ThinGateway } from '../../gateway-spike.mjs';
import { MetadataLogger, createTracing, withRequestSpan } from './observability.mjs';
import { PersistentMetadataStore } from './persistence.mjs';

function keyDigest(value, secret) {
  return createHmac('sha256', secret).update(value).digest('hex');
}

function defaultFixture(upstream, principalKey, pepper) {
  return new ThinGateway({
    principals: [{
      id: 'poc-employee-01',
      key: principalKey,
      status: 'ACTIVE',
      models: ['qianliu-model'],
      quota: 100_000,
      used: 0,
      allowOverage: false,
      concurrency: 20,
    }],
    resources: [{
      id: 'deepseek-poc-resource',
      mode: 'API',
      status: 'ACTIVE',
      capabilities: ['chat', 'messages'],
      concurrency: 100,
      priority: 1,
      weight: 100,
      errorRate: 0,
      ttftMs: 10,
      remaining: 1,
      marginalCost: 0.001,
      multiplier: 1,
      equivalentGroup: 'poc',
    }],
    routes: [{
      model: 'qianliu-model',
      capabilities: ['chat', 'messages'],
      resources: ['deepseek-poc-resource'],
    }],
    upstream,
    pepper,
    affinitySecret: `${pepper}:affinity`,
  });
}

function jsonError(error) {
  const status = error instanceof GatewayError ? error.status : 503;
  const code = error.code ?? 'gateway_dependency_unavailable';
  return {
    status,
    body: {
      error: {
        type: code,
        message: status >= 500 ? 'Gateway 暂时不可用' : error.message,
        retryable: status >= 500,
      },
    },
  };
}

export async function createPersistentGateway({
  databaseUrl,
  redisUrl,
  schemaPath,
  logPath,
  principalKey,
  pepper,
  upstream = async () => ({
    status: 200,
    committed: true,
    usage: { input: 11, output: 7, cache: 0, quality: 'PROVIDER_REPORTED' },
    cost: 0.000018,
  }),
}) {
  const store = new PersistentMetadataStore({ databaseUrl, redisUrl, schemaPath });
  await store.connect();
  const logger = new MetadataLogger(logPath);
  const tracing = createTracing();
  const gateway = defaultFixture(upstream, principalKey, pepper);

  async function execute({ id, key, model, capability, body, sessionId }) {
    const existing = await store.getSettlement(id);
    if (existing) return { replay: true, settlement: existing };
    const lock = await store.acquire(id);
    if (!lock.acquired) {
      const settlement = await store.waitForSettlement(id);
      if (!settlement) throw new GatewayError(409, 'request_in_progress', '相同请求正在处理');
      return { replay: true, settlement };
    }

    const started = performance.now();
    try {
      const gatewayResult = await withRequestSpan(
        tracing,
        { request_id: id, model, capability },
        () => gateway.handle({
          id,
          key,
          model,
          capability,
          messages: body.messages,
          sessionId,
        }),
      );
      const settlement = await store.persist({
        request: { id },
        gatewayResult,
        gateway,
      });
      const metadata = gateway.requests.get(id);
      await logger.write({
        level: 'info',
        event: 'gateway.request.completed',
        requestId: id,
        principalId: metadata.principalId,
        model,
        capability,
        status: settlement.status,
        attemptCount: settlement.attemptCount,
        durationMs: Number((performance.now() - started).toFixed(3)),
      });
      return { settlement };
    } catch (error) {
      await logger.write({
        level: 'error',
        event: 'gateway.request.failed',
        requestId: id,
        model,
        capability,
        errorCode: error.code ?? 'dependency_error',
        durationMs: Number((performance.now() - started).toFixed(3)),
      });
      throw error;
    } finally {
      await store.release(lock).catch(() => undefined);
    }
  }

  async function handleHttp({ method, path, headers = {}, body = {} }) {
    try {
      await store.health();
      const bearer = headers.authorization?.match(/^Bearer (.+)$/i)?.[1];
      if (!bearer || keyDigest(bearer, pepper) !== keyDigest(principalKey, pepper)) {
        throw new GatewayError(401, 'invalid_principal_key', '主体 Key 无效');
      }
      if (method === 'GET' && path === '/v1/models') {
        return {
          status: 200,
          body: { object: 'list', data: [{ id: 'qianliu-model', object: 'model', owned_by: 'qianliu' }] },
        };
      }

      const capability =
        method === 'POST' && path === '/v1/chat/completions' ? 'chat'
          : method === 'POST' && path === '/v1/messages' ? 'messages'
            : null;
      if (!capability) {
        throw new GatewayError(422, 'capability_not_supported', '一期未启用该能力', {
          retryable: false,
        });
      }
      const id = headers['x-request-id'] ?? randomUUID();
      const result = await execute({
        id,
        key: bearer,
        model: body.model,
        capability,
        body,
        sessionId: headers['x-session-id'],
      });
      if (capability === 'messages') {
        return {
          status: 200,
          body: {
            id: `msg_${id}`,
            type: 'message',
            role: 'assistant',
            model: body.model,
            content: [{ type: 'text', text: 'POC_OK' }],
            usage: {
              input_tokens: result.settlement.usage.input,
              output_tokens: result.settlement.usage.output,
            },
            qianliu: { request_id: id, replay: Boolean(result.replay) },
          },
        };
      }
      return {
        status: 200,
        body: {
          id: `chatcmpl-${id}`,
          object: 'chat.completion',
          model: body.model,
          choices: [{ index: 0, message: { role: 'assistant', content: 'POC_OK' }, finish_reason: 'stop' }],
          usage: {
            prompt_tokens: result.settlement.usage.input,
            completion_tokens: result.settlement.usage.output,
            total_tokens: result.settlement.usage.input + result.settlement.usage.output,
          },
          qianliu: { request_id: id, replay: Boolean(result.replay) },
        },
      };
    } catch (error) {
      return jsonError(error);
    }
  }

  async function scanCanary(canary) {
    await tracing.exporter.forceFlush?.();
    const stores = await store.scanCanary(canary);
    const logHits = (await logger.text()).includes(canary) ? 1 : 0;
    const spans = tracing.exporter.getFinishedSpans();
    const traceHits = JSON.stringify(spans.map((span) => ({
      name: span.name,
      attributes: span.attributes,
      events: span.events,
    }))).includes(canary) ? 1 : 0;
    return { ...stores, logs: logHits, traces: traceHits };
  }

  return {
    gateway,
    handleHttp,
    logger,
    scanCanary,
    store,
    tracing,
    async close() {
      await store.close();
      await tracing.shutdown();
    },
  };
}
