/**
 * 官方 Codex CLI → Gateway Responses → real-pipeline → ledger 可执行 E2E。
 *
 * 使用临时 PostgreSQL 与 `codex --ignore-user-config --ephemeral`，不修改用户配置。
 * 上游使用本地真实 TCP Chat Completions 服务 + 生产 OpenAI-compatible HTTP caller：
 * 验证 Codex Responses、工具回合、协议转换、上游鉴权、Usage 与账本闭环，不经过 Stub。
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  createKysely,
  GatewayLedgerRepository,
  migrateToLatest,
  QuotaGateRepository,
  ResourcePoolRepository,
} from "@qianliu/database";
import { startPostgresContainer } from "@qianliu/testing";
import {
  apiKeyPrefix,
  createOpenAiCompatibleCaller,
  digestApiKey,
  generateApiKey,
  SecretValue,
} from "@qianliu/provider-adapters";
import { buildGateway } from "../server.js";
import { createRealPipeline, type RouteCandidateRow } from "../pipeline/real-pipeline.js";

const pepper = "codex-e2e-pepper-32bytes-minimum";
const enterpriseId = randomUUID();
const principalId = randomUUID();
const localUpstreamSecret = "codex-e2e-local-upstream-secret";
const codexBinary = process.env.CODEX_E2E_BIN
  ?? "codex";

const pg = await startPostgresContainer("qianliu_codex_e2e");
const db = createKysely(pg.connectionString);
const workspace = await mkdtemp(join(tmpdir(), "qianliu-codex-e2e-"));
let app: ReturnType<typeof buildGateway> | undefined;
let upstreamServer: ReturnType<typeof createServer> | undefined;

try {
  await migrateToLatest(db);
  await db.insertInto("enterprise").values({ id: enterpriseId, name: "Codex E2E" }).execute();
  await db.insertInto("principal").values({
    id: principalId,
    enterprise_id: enterpriseId,
    type: "PROJECT",
    name: "Codex CLI E2E",
  }).execute();
  const model = await db.insertInto("unified_model").values({
    enterprise_id: enterpriseId,
    alias: "qianliu-deepseek",
    display_name: "Codex E2E Model",
    status: "ACTIVE",
  }).returningAll().executeTakeFirstOrThrow();
  const key = generateApiKey();
  await db.insertInto("principal_key").values({
    enterprise_id: enterpriseId,
    principal_id: principalId,
    key_prefix: apiKeyPrefix(key),
    key_digest: digestApiKey(key, pepper),
    allowed_model_ids: JSON.stringify([model.id]) as unknown as string[],
    status: "ACTIVE",
  }).execute();
  const provider = await db.insertInto("provider").values({
    enterprise_id: enterpriseId,
    code: "deepseek",
    name: "DeepSeek E2E",
    adapter_type: "deepseek",
  }).returningAll().executeTakeFirstOrThrow();
  const resource = await db.insertInto("provider_resource").values({
    enterprise_id: enterpriseId,
    provider_id: provider.id,
    name: "Codex E2E API",
    mode: "API",
    credential_type: "API_KEY",
  }).returningAll().executeTakeFirstOrThrow();
  await db.insertInto("model_route").values({
    enterprise_id: enterpriseId,
    unified_model_id: model.id,
    provider_resource_id: resource.id,
    upstream_model: "deepseek-chat",
  }).execute();
  await db.insertInto("principal_grant").values({
    enterprise_id: enterpriseId,
    principal_id: principalId,
    provider: "deepseek",
    model_alias: model.alias,
    quota_value: 1_000_000n,
  }).execute();

  const ledgerRepo = new GatewayLedgerRepository(db);
  const poolRepo = new ResourcePoolRepository(db);
  const quotaRepo = new QuotaGateRepository(db);
  const upstreamRequests: CapturedUpstreamRequest[] = [];
  upstreamServer = createLocalChatCompletionsServer(upstreamRequests);
  await new Promise<void>((resolve) => upstreamServer!.listen(0, "127.0.0.1", resolve));
  const upstreamAddress = upstreamServer.address() as AddressInfo;
  const caller = createOpenAiCompatibleCaller({
    env: {
      DEEPSEEK_BASE_URL: `http://127.0.0.1:${upstreamAddress.port}/v1`,
    },
  });
  const listCandidates = async (entId: string, alias: string): Promise<RouteCandidateRow[]> => {
    if (entId !== enterpriseId || alias !== model.alias) return [];
    return [{
      resourceId: resource.id,
      providerCode: "deepseek",
      upstreamModel: "deepseek-chat",
      priority: 100,
      weight: 1,
      mode: "API",
      status: "ACTIVE",
      probe: false,
      principalId,
      secret: new SecretValue(localUpstreamSecret),
      concurrencyLimit: 2,
    }];
  };
  const pipeline = createRealPipeline({
    db,
    ledgerRepo,
    poolRepo,
    quotaRepo,
    listCandidates,
    caller,
  });
  app = buildGateway(db, pepper, pipeline);
  await app.listen({ host: "127.0.0.1", port: 0 });
  const port = (app.server.address() as AddressInfo).port;
  const baseUrl = `http://127.0.0.1:${port}/v1`;

  const args = [
    "exec",
    "--ignore-user-config",
    "--ephemeral",
    "--skip-git-repo-check",
    "--sandbox",
    "read-only",
    "--cd",
    workspace,
    "--model",
    model.alias,
    "--json",
    "-c",
    'model_provider="qianliu"',
    "-c",
    'model_providers.qianliu.name="Qianliu Gateway E2E"',
    "-c",
    `model_providers.qianliu.base_url="${baseUrl}"`,
    "-c",
    'model_providers.qianliu.env_key="QIANLIU_E2E_KEY"',
    "-c",
    'model_providers.qianliu.wire_api="responses"',
    "-c",
    "model_providers.qianliu.requires_openai_auth=false",
    "调用一个可用的 shell 工具打印 Codex gateway E2E，然后只回复 OK。",
  ];
  const cli = await run(codexBinary, args, {
    ...process.env,
    QIANLIU_E2E_KEY: key,
  });
  const requests = await db
    .selectFrom("ai_request")
    .select(["id", "protocol", "status", "stream", "unified_model"])
    .orderBy("started_at", "asc")
    .execute();
  const transactions = await db
    .selectFrom("ledger_transaction")
    .select([
      "ai_request_id",
      "total_input_tokens",
      "total_output_tokens",
      "total_cache_tokens",
      "total_reasoning_tokens",
      "total_api_cost",
    ])
    .orderBy("created_at", "asc")
    .execute();
  const summary = {
    codexVersion: (await run(codexBinary, ["--version"], process.env)).stdout.trim(),
    exitCode: cli.code,
    baseUrl,
    model: model.alias,
    upstreamCalls: upstreamRequests.length,
    upstreamRequests: upstreamRequests.map((request) => ({
      path: request.path,
      authorizationMatched: request.authorization === `Bearer ${localUpstreamSecret}`,
      authorization: request.authorization ? "Bearer [REDACTED]" : null,
      bodyShape: {
        model: typeof request.body.model === "string" ? request.body.model : null,
        messageCount: Array.isArray(request.body.messages) ? request.body.messages.length : 0,
        toolCount: Array.isArray(request.body.tools) ? request.body.tools.length : 0,
        stream: request.body.stream === true,
      },
      toolResultCount: request.toolResults.length,
      reportedUsage: request.reportedUsage,
    })),
    requests: requests.map((request) => ({
      ...request,
      requestId: request.id,
    })),
    transactions: transactions.map((transaction) => ({
      ...transaction,
      total_input_tokens: transaction.total_input_tokens.toString(),
      total_output_tokens: transaction.total_output_tokens.toString(),
      total_cache_tokens: transaction.total_cache_tokens.toString(),
      total_reasoning_tokens: transaction.total_reasoning_tokens.toString(),
    })),
    clientEventTypes: cli.stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { type?: unknown })
      .map((event) => typeof event.type === "string" ? event.type : "unknown"),
    stderrLineCount: cli.stderr.split("\n").filter(Boolean).length,
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  const observedToolResult = upstreamRequests.some((request) => request.toolResults.length > 0);
  const authMatched = upstreamRequests.every(
    (request) => request.authorization === `Bearer ${localUpstreamSecret}`,
  );
  if (
    cli.code !== 0
    || requests.length < 2
    || transactions.length < 2
    || upstreamRequests.length < 2
    || !observedToolResult
    || !authMatched
  ) {
    process.exitCode = 1;
  }
} finally {
  if (app) await app.close();
  if (upstreamServer) {
    await new Promise<void>((resolve, reject) => {
      upstreamServer!.close((error) => error ? reject(error) : resolve());
    });
  }
  await db.destroy();
  await pg.stop();
  await rm(workspace, { recursive: true, force: true });
}

interface CapturedUpstreamRequest {
  path: string;
  authorization: string;
  body: Record<string, unknown>;
  toolResults: string[];
  reportedUsage: {
    prompt_tokens: number;
    completion_tokens: number;
    prompt_cache_hit_tokens: number;
    completion_tokens_details: { reasoning_tokens: number };
  };
}

function createLocalChatCompletionsServer(
  captured: CapturedUpstreamRequest[],
): ReturnType<typeof createServer> {
  return createServer((request, response) => {
    let raw = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      raw += chunk;
    });
    request.on("end", () => {
      const body = JSON.parse(raw) as Record<string, unknown>;
      const messages = Array.isArray(body.messages)
        ? body.messages.filter(isRecord)
        : [];
      const toolResults = messages
        .filter((message) => message.role === "tool")
        .map((message) => typeof message.content === "string"
          ? message.content
          : JSON.stringify(message.content));
      const reportedUsage = {
        prompt_tokens: 120,
        completion_tokens: 32,
        prompt_cache_hit_tokens: 20,
        completion_tokens_details: { reasoning_tokens: 8 },
      };
      captured.push({
        path: request.url ?? "",
        authorization: request.headers.authorization ?? "",
        body,
        toolResults,
        reportedUsage,
      });

      if (body.stream !== true) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          choices: [{
            message: { role: "assistant", content: toolResults.length > 0 ? "OK" : "" },
            finish_reason: "stop",
          }],
          usage: reportedUsage,
        }));
        return;
      }

      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      if (toolResults.length === 0) {
        writeChatSse(response, {
          choices: [{
            index: 0,
            delta: {
              tool_calls: [{
                index: 0,
                id: "call_codex_e2e",
                type: "function",
                function: {
                  name: "exec_command",
                  arguments: JSON.stringify({
                    cmd: "printf 'Codex gateway E2E\\n'",
                  }),
                },
              }],
            },
            finish_reason: null,
          }],
        });
        writeChatSse(response, {
          choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
        });
      } else {
        writeChatSse(response, {
          choices: [{
            index: 0,
            delta: { content: "OK" },
            finish_reason: null,
          }],
        });
        writeChatSse(response, {
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        });
      }
      writeChatSse(response, { choices: [], usage: reportedUsage });
      response.end("data: [DONE]\n\n");
    });
  });
}

function writeChatSse(
  response: ServerResponse,
  payload: Record<string, unknown>,
): void {
  response.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function run(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}
