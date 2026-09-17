import { randomUUID } from "node:crypto";
import type { AdapterRequest, AdapterResource } from "./index.js";
import { SecretValue } from "./secret-value.js";
import { createOpenAiCompatibleCaller, type HttpFetch } from "./openai-compatible-caller.js";

export interface ModelValidationCheck {
  kind: "NON_STREAM" | "STREAM" | "TOOL";
  status: number;
  ok: boolean;
  durationMs: number;
  firstByteMs: number | null;
  usage: { input: number; output: number; cache: number; reasoning: number };
  errorCode: string | null;
}

export interface ModelValidationEvidence {
  validationId?: string;
  requestId: string;
  upstreamModel: string;
  status: "SUCCEEDED" | "FAILED";
  checks: ModelValidationCheck[];
  errorCode: string | null;
  startedAt: string;
  finishedAt: string;
}

export async function validateProviderModel(input: {
  providerCode: AdapterResource["providerCode"];
  mode: AdapterResource["mode"];
  resourceId: string;
  upstreamModel: string;
  credential: string;
  baseUrl?: string;
  reasoningEffort?: "low" | "high" | "max";
  runToolCheck: boolean;
  fetch?: HttpFetch;
  env?: NodeJS.ProcessEnv;
  requestId?: string;
}): Promise<ModelValidationEvidence> {
  const startedAt = new Date();
  const requestId = input.requestId ?? `mdv-${randomUUID()}`;
  const caller = createOpenAiCompatibleCaller({
    fetch: input.fetch,
    env: input.env,
    requestTimeoutMs: 60_000,
    firstByteTimeoutMs: 15_000,
    streamIdleTimeoutMs: 15_000,
  });
  const resource: AdapterResource = {
    providerCode: input.providerCode,
    resourceId: input.resourceId,
    mode: input.mode,
    upstreamModel: input.upstreamModel,
    concurrencyLimit: 1,
    baseUrl: input.baseUrl,
    secret: new SecretValue(input.credential),
  };
  const checks: ModelValidationCheck[] = [];
  checks.push(await runCheck(caller, resource, requestId, "NON_STREAM", {
    messages: [{ role: "user", content: "Reply with the single word: ok" }],
    ...(input.reasoningEffort ? { reasoning_effort: input.reasoningEffort } : {}),
  }, false));
  checks.push(await runCheck(caller, resource, requestId, "STREAM", {
    messages: [{ role: "user", content: "Reply with the single word: ok" }],
    ...(input.reasoningEffort ? { reasoning_effort: input.reasoningEffort } : {}),
  }, true));
  if (input.runToolCheck) {
    checks.push(await runCheck(caller, resource, requestId, "TOOL", {
      messages: [{ role: "user", content: "Call the validation tool with value ok." }],
      ...(input.reasoningEffort ? { reasoning_effort: input.reasoningEffort } : {}),
      tools: [{
        type: "function",
        function: {
          name: "qianliu_validation_echo",
          description: "A no-op validation tool.",
          parameters: {
            type: "object",
            properties: { value: { type: "string" } },
            required: ["value"],
            additionalProperties: false,
          },
        },
      }],
      tool_choice: { type: "function", function: { name: "qianliu_validation_echo" } },
    }, false));
  }
  const failed = checks.find((check) => !check.ok);
  const finishedAt = new Date();
  return {
    requestId,
    upstreamModel: input.upstreamModel,
    status: failed ? "FAILED" : "SUCCEEDED",
    checks,
    errorCode: failed?.errorCode ?? null,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
  };
}

async function runCheck(
  caller: Awaited<ReturnType<typeof createOpenAiCompatibleCaller>>,
  resource: AdapterResource,
  requestId: string,
  kind: ModelValidationCheck["kind"],
  body: Record<string, unknown>,
  stream: boolean,
): Promise<ModelValidationCheck> {
  const started = Date.now();
  const request: AdapterRequest = {
    requestId: `${requestId}-${kind.toLowerCase()}`,
    unifiedModel: `validation:${resource.upstreamModel}`,
    stream,
    body,
    ...(stream ? { onStreamChunk: () => undefined } : {}),
  };
  const outcome = await caller(resource, request, 1);
  const durationMs = Date.now() - started;
  const toolOk = kind !== "TOOL" || (outcome.responseOutput ?? []).some((item) =>
    item && typeof item === "object" && (item as { type?: unknown }).type === "function_call");
  const ok = outcome.status >= 200 && outcome.status < 300 && !outcome.error && outcome.committed && toolOk;
  return {
    kind,
    status: outcome.status,
    ok,
    durationMs,
    firstByteMs: outcome.firstByteAt === undefined ? null : Math.max(0, outcome.firstByteAt - started),
    usage: {
      input: outcome.usage.input,
      output: outcome.usage.output,
      cache: outcome.usage.cache,
      reasoning: outcome.usage.reasoning ?? 0,
    },
    errorCode: ok ? null : outcome.upstreamCode ?? outcome.error ?? `HTTP_${outcome.status}`,
  };
}
