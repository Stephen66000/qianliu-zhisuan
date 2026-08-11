import { appendFile, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { mkdir } from 'node:fs/promises';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';

const LOG_FIELDS = new Set([
  'time',
  'level',
  'event',
  'requestId',
  'principalId',
  'model',
  'capability',
  'status',
  'attemptCount',
  'errorCode',
  'durationMs',
]);

export class MetadataLogger {
  constructor(path) {
    this.path = path;
  }

  async write(fields) {
    const safe = {};
    for (const [key, value] of Object.entries(fields)) {
      if (LOG_FIELDS.has(key) && value !== undefined) safe[key] = value;
    }
    safe.time ??= new Date().toISOString();
    await mkdir(dirname(this.path), { recursive: true });
    await appendFile(this.path, `${JSON.stringify(safe)}\n`, { encoding: 'utf8', mode: 0o600 });
  }

  async text() {
    return readFile(this.path, 'utf8').catch((error) => {
      if (error.code === 'ENOENT') return '';
      throw error;
    });
  }
}

export function createTracing() {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  const tracer = provider.getTracer('qianliu-zhisuan-gateway-poc', '0.1.0');
  return {
    exporter,
    tracer,
    async shutdown() {
      await provider.forceFlush();
      await provider.shutdown();
    },
  };
}

export async function withRequestSpan(tracing, attributes, operation) {
  return tracing.tracer.startActiveSpan('gateway.request', async (span) => {
    const started = performance.now();
    for (const [key, value] of Object.entries(attributes)) {
      if (value !== undefined) span.setAttribute(`gateway.${key}`, value);
    }
    try {
      const result = await operation();
      span.setAttribute('gateway.status', result.settlement.status);
      span.setAttribute('gateway.attempt_count', result.settlement.attemptCount);
      return result;
    } catch (error) {
      span.setAttribute('gateway.status', 'ERROR');
      span.setAttribute('gateway.error_code', error.code ?? 'internal_error');
      throw error;
    } finally {
      span.setAttribute('gateway.duration_ms', Number((performance.now() - started).toFixed(3)));
      span.end();
    }
  });
}
