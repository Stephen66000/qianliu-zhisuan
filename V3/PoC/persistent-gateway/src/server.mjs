import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createPersistentGateway } from './app.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

const app = await createPersistentGateway({
  databaseUrl: required('DATABASE_URL'),
  redisUrl: required('REDIS_URL'),
  schemaPath: resolve(root, 'schema.sql'),
  logPath: process.env.GATEWAY_LOG_PATH ?? resolve(root, '.runtime/gateway.jsonl'),
  principalKey: required('POC_PRINCIPAL_KEY'),
  pepper: required('GATEWAY_KEY_PEPPER'),
});

const server = createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  let body = {};
  try {
    if (chunks.length > 0) body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    response.writeHead(400, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { type: 'invalid_json', message: 'JSON 格式错误' } }));
    return;
  }
  const result = await app.handleHttp({
    method: request.method,
    path: new URL(request.url, 'http://gateway.local').pathname,
    headers: request.headers,
    body,
  });
  response.writeHead(result.status, {
    'content-type': 'application/json',
    'x-content-type-options': 'nosniff',
  });
  response.end(JSON.stringify(result.body));
});

const port = Number(process.env.PORT ?? 4318);
server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`qianliu-poc-gateway listening on http://127.0.0.1:${port}\n`);
});

async function shutdown() {
  server.close();
  await app.close();
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
