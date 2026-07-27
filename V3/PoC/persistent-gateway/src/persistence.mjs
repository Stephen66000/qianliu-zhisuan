import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { createClient } from 'redis';

const { Pool } = pg;
const LOCK_TTL_MS = 15_000;

function normalizeSettlement(row) {
  if (!row) return null;
  return {
    requestId: row.request_id,
    status: row.status,
    usage: {
      input: Number(row.input_tokens),
      output: Number(row.output_tokens),
      cache: Number(row.cache_tokens),
    },
    quality: row.usage_quality,
    apiCost: Number(row.api_cost),
    deduction: Number(row.deduction),
    overage: row.overage,
    attemptCount: row.attempt_count,
    saving: row.saving === 'NOT_CALCULABLE' ? 'NOT_CALCULABLE' : Number(row.saving),
  };
}

export class PersistentMetadataStore {
  constructor({ databaseUrl, redisUrl, schemaPath }) {
    this.pool = new Pool({ connectionString: databaseUrl, max: 5 });
    this.redis = createClient({ url: redisUrl });
    this.schemaPath = schemaPath;
  }

  async connect() {
    this.redis.on('error', () => undefined);
    await this.redis.connect();
    const schema = await readFile(this.schemaPath, 'utf8');
    await this.pool.query(schema);
  }

  async health() {
    const [postgres, redis] = await Promise.all([
      this.pool.query('SELECT 1 AS ok'),
      this.redis.ping(),
    ]);
    return { postgres: postgres.rows[0].ok === 1, redis: redis === 'PONG' };
  }

  async acquire(requestId) {
    const key = `gateway:lock:${requestId}`;
    const acquired = await this.redis.set(key, '1', { NX: true, PX: LOCK_TTL_MS });
    return { acquired: acquired === 'OK', key };
  }

  async release(lock) {
    await this.redis.del(lock.key);
  }

  async getSettlement(requestId) {
    const cached = await this.redis.get(`gateway:idem:${requestId}`);
    if (cached) return JSON.parse(cached);
    const result = await this.pool.query(
      'SELECT * FROM gateway_settlements WHERE request_id = $1',
      [requestId],
    );
    const settlement = normalizeSettlement(result.rows[0]);
    if (settlement) {
      await this.redis.set(`gateway:idem:${requestId}`, JSON.stringify(settlement), { EX: 3600 });
    }
    return settlement;
  }

  async persist({ request, gatewayResult, gateway }) {
    const metadata = gateway.requests.get(request.id);
    const attempts = gateway.attempts.filter((item) => item.requestId === request.id);
    const dispatch = gateway.dispatchEvidence.find((item) => item.requestId === request.id);
    const settlement = gatewayResult.settlement;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO gateway_requests
          (request_id, principal_id, model, capability, session_hash, status, completed_at)
         VALUES ($1, $2, $3, $4, $5, $6, now())
         ON CONFLICT (request_id) DO NOTHING`,
        [
          request.id,
          metadata.principalId,
          metadata.model,
          metadata.capability,
          metadata.sessionHash,
          metadata.status,
        ],
      );
      for (const attempt of attempts) {
        await client.query(
          `INSERT INTO gateway_attempts
            (request_id, attempt_no, resource_id, status, committed, error_code,
             input_tokens, output_tokens, cache_tokens, usage_quality, api_cost)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
           ON CONFLICT (request_id, attempt_no) DO NOTHING`,
          [
            request.id,
            attempt.number,
            attempt.resourceId,
            attempt.status,
            attempt.committed,
            attempt.error,
            attempt.usage.input ?? 0,
            attempt.usage.output ?? 0,
            attempt.usage.cache ?? 0,
            attempt.usage.quality ?? 'UNAVAILABLE',
            attempt.cost,
          ],
        );
      }
      if (dispatch) {
        await client.query(
          `INSERT INTO gateway_dispatches
            (request_id, action, reason_code, baseline_resource_id, candidates)
           VALUES ($1,$2,$3,$4,$5::jsonb)
           ON CONFLICT (request_id) DO NOTHING`,
          [request.id, dispatch.action, dispatch.code, dispatch.baseline, JSON.stringify(dispatch.candidates)],
        );
      }
      await client.query(
        `INSERT INTO gateway_settlements
          (request_id, status, input_tokens, output_tokens, cache_tokens, usage_quality,
           api_cost, deduction, overage, attempt_count, saving)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         ON CONFLICT (request_id) DO NOTHING`,
        [
          request.id,
          settlement.status,
          settlement.usage.input,
          settlement.usage.output,
          settlement.usage.cache,
          settlement.quality,
          settlement.apiCost,
          settlement.deduction,
          settlement.overage,
          settlement.attemptCount,
          String(settlement.saving),
        ],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

    await this.redis.set(`gateway:idem:${request.id}`, JSON.stringify(settlement), { EX: 3600 });
    if (metadata.sessionHash && attempts.length > 0) {
      await this.redis.set(
        `gateway:affinity:${metadata.sessionHash}`,
        attempts.at(-1).resourceId,
        { EX: 1800 },
      );
    }
    return settlement;
  }

  async waitForSettlement(requestId, timeoutMs = 5_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const settlement = await this.getSettlement(requestId);
      if (settlement) return settlement;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return null;
  }

  async scanCanary(canary) {
    const postgres = await this.pool.query(
      `SELECT
         (SELECT count(*) FROM gateway_requests r WHERE row_to_json(r)::text LIKE '%' || $1 || '%') +
         (SELECT count(*) FROM gateway_attempts a WHERE row_to_json(a)::text LIKE '%' || $1 || '%') +
         (SELECT count(*) FROM gateway_settlements s WHERE row_to_json(s)::text LIKE '%' || $1 || '%') +
         (SELECT count(*) FROM gateway_dispatches d WHERE row_to_json(d)::text LIKE '%' || $1 || '%')
         AS hits`,
      [canary],
    );
    let redisHits = 0;
    for await (const batch of this.redis.scanIterator({ MATCH: 'gateway:*', COUNT: 100 })) {
      for (const key of Array.isArray(batch) ? batch : [batch]) {
        const value = await this.redis.get(key);
        if (`${key}${value ?? ''}`.includes(canary)) redisHits += 1;
      }
    }
    return { postgres: Number(postgres.rows[0].hits), redis: redisHits };
  }

  async reset() {
    await this.pool.query(
      'TRUNCATE gateway_dispatches, gateway_settlements, gateway_attempts, gateway_requests CASCADE',
    );
    for await (const batch of this.redis.scanIterator({ MATCH: 'gateway:*', COUNT: 100 })) {
      const keys = Array.isArray(batch) ? batch : [batch];
      if (keys.length > 0) await this.redis.del(keys);
    }
  }

  async close() {
    if (this.redis.isOpen) await this.redis.quit();
    await this.pool.end();
  }
}
