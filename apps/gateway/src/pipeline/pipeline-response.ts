import type { Outcome } from "@qianliu/contracts";
import { buildResponsesResponse, writeResponsesSse } from "../routes/responses-protocol.js";
import { northboundFailurePresentation } from "./upstream-error-diagnostic.js";
import { publishFailedRequest } from "./pipeline-failure-settlement.js";
import {
  providerDisplayName,
  sendDispatchTermination,
  sendRuntimeBlock,
} from "./runtime-controls.js";
import type { PipelineContext, PipelineExecutionState } from "./real-pipeline-types.js";

export async function sendPipelineResponse(
  context: PipelineContext,
  state: PipelineExecutionState,
): Promise<void> {
  if (state.dispatchTerminated) {
    await sendDispatchTermination(
      context.reply,
      context.capability,
      context.traceId,
      context.requestId,
      {
        finalAction: state.dispatchFinalAction as "REJECT" | "RATE_LIMIT",
        reasonCode: state.dispatchReasonCode,
        matchedPolicy: state.dispatchMatchedPolicy,
        requestStartedAt: context.requestStartedAt,
        updateStatus: (errorCode) => context.deps.ledgerRepo.updateRequestStatus(
          context.requestId, "FAILED", errorCode, state.dispatchReasonCode,
        ),
      },
    );
    return;
  }
  if (!state.finalOutcome) {
    await sendMissingOutcomeResponse(context, state);
    return;
  }
  if (state.finalOutcome.error) {
    sendFinalOutcomeFailure(context, state, state.finalOutcome);
    return;
  }
  sendSuccessfulOutcome(context, state.finalOutcome);
}

function sendFinalOutcomeFailure(
  context: PipelineContext,
  state: PipelineExecutionState,
  outcome: Outcome,
): void {
  const { reply, capability, traceId, requestId, streamWriter } = context;
  if (state.finalSignalResult?.decision === "BLOCKED_UPSTREAM" && state.finalSignalResult.event) {
    sendRuntimeBlock(reply, capability, traceId, requestId, state.finalSignalResult.event);
    return;
  }
  if (streamWriter?.committed) {
    streamWriter.fail({
      code: outcome.error === "stream_interrupted_after_commit"
        ? "upstream_stream_interrupted"
        : outcome.error!,
      message: outcome.error === "upstream_timeout"
        ? "上游流超时"
        : "上游流在输出期间中断",
      requestId,
    });
    return;
  }
  const quotaExhausted = outcome.upstreamErrorKind === "QUOTA_EXHAUSTED";
  const windowExhausted = outcome.upstreamErrorKind === "WINDOW_EXHAUSTED";
  const status = outcome.status === 400
    ? 400
    : quotaExhausted || windowExhausted || outcome.status === 429
      ? 429
      : outcome.status === 504
        ? 504
        : 502;
  const errorType = status === 400
    ? "invalid_request_error"
    : status === 429
      ? "rate_limit_error"
      : "server_error";
  const errorCode = quotaExhausted
    ? "upstream_quota_exhausted"
    : windowExhausted
      ? "upstream_window_exhausted"
      : outcome.upstreamErrorEvidence?.messageCategory === "MODEL_IMAGE_UNSUPPORTED"
        ? "model_image_unsupported" : outcome.error;
  const presentation = northboundFailurePresentation(
    outcome,
    providerDisplayName(state.finalOutcomeProviderCode),
    quotaExhausted || windowExhausted,
    capability,
  );
  if (outcome.retryAfterMs !== undefined) {
    reply.header("retry-after", Math.max(1, Math.ceil(outcome.retryAfterMs / 1_000)));
  }
  reply.code(status).header("x-request-id", traceId).send({
    error: {
      message: presentation.message,
      type: errorType,
      code: errorCode,
      param: presentation.param,
      retryable: status !== 400 && !quotaExhausted,
      ...presentation.diagnosticExtension,
      ...(outcome.retryAfterMs === undefined ? {} : { retry_after_ms: outcome.retryAfterMs }),
      request_id: requestId,
      ...(quotaExhausted || windowExhausted ? {
        provider: state.finalOutcomeProviderCode,
        next_reset_at: outcome.recoverAt ?? null,
        not_calculable_reason: outcome.recoverAt ? null : "PROVIDER_RESET_TIME_UNKNOWN",
      } : {}),
    },
  });
}

function sendSuccessfulOutcome(context: PipelineContext, outcome: Outcome): void {
  const { reply, capability, traceId, requestId, streamWriter, body } = context;
  if (capability === "messages") {
    if (streamWriter) {
      streamWriter.complete(outcome);
      return;
    }
    const assistant = normalizeAssistantOutput(outcome.responseOutput);
    const content: unknown[] = [];
    if (assistant.text) content.push({ type: "text", text: assistant.text });
    for (const call of assistant.functionCalls) {
      content.push({
        type: "tool_use",
        id: call.callId,
        name: call.name,
        input: parseToolArguments(call.arguments),
      });
    }
    if (content.length === 0) content.push({ type: "text", text: "OK" });
    reply.header("x-request-id", traceId).code(200).send({
      id: `msg_${requestId}`,
      type: "message",
      role: "assistant",
      model: body.model,
      content,
      stop_reason: assistant.functionCalls.length > 0 ? "tool_use" : "end_turn",
      usage: { input_tokens: outcome.usage.input, output_tokens: outcome.usage.output },
    });
    return;
  }
  if (capability === "responses") {
    const response = buildResponsesResponse({
      requestId,
      createdAt: context.created,
      model: body.model,
      request: body.responsesRequest!,
      inputTokens: outcome.usage.input,
      outputTokens: outcome.usage.output,
      cacheTokens: outcome.usage.cache,
      reasoningTokens: outcome.usage.reasoning ?? 0,
      output: outcome.responseOutput,
    });
    if (body.stream) {
      writeResponsesSse(reply, response, traceId);
      return;
    }
    reply.header("x-request-id", traceId).code(200).send(response);
    return;
  }
  const assistant = normalizeAssistantOutput(outcome.responseOutput);
  if (streamWriter) {
    streamWriter.complete(outcome);
    return;
  }
  reply.header("x-request-id", traceId).code(200).send({
    id: `chatcmpl-${requestId}`,
    object: "chat.completion",
    created: context.created,
    model: body.model,
    choices: [{
      index: 0,
      message: Object.assign({
        role: "assistant",
        content: assistant.text || (assistant.functionCalls.length > 0 ? null : "OK"),
        ...(assistant.functionCalls.length > 0
          ? {
              tool_calls: assistant.functionCalls.map((call) => ({
                id: call.callId,
                type: "function",
                function: { name: call.name, arguments: call.arguments },
              })),
            }
          : {}),
      }, outcome.responseReasoningExtensions ?? {}),
      finish_reason: assistant.functionCalls.length > 0 ? "tool_calls" : "stop",
    }],
    usage: {
      prompt_tokens: outcome.usage.input,
      completion_tokens: outcome.usage.output,
      total_tokens: outcome.usage.input + outcome.usage.output,
    },
  });
}

async function sendMissingOutcomeResponse(
  context: PipelineContext,
  state: PipelineExecutionState,
): Promise<void> {
  const { reply, requestId, traceId } = context;
  if (state.grantRevokedDuringDispatch) {
    await publishFailedRequest(context, state, "DOWNSTREAM_AUTH_OR_QUOTA", "principal_grant_required");
    reply.code(403).header("x-request-id", traceId).send({
      error: {
        message: "主体授权在访问上游前已失效",
        type: "authentication_error",
        code: "principal_grant_required",
        param: "model",
        retryable: false,
        request_id: requestId,
      },
    });
    return;
  }
  if (state.capacityWaitTimedOut) {
    await publishFailedRequest(context, state, "UPSTREAM_RATE_LIMITED", "resource_capacity_busy");
    reply.code(429).header("retry-after", Math.max(1, Math.ceil(state.capacityRetryAfterMs / 1_000))).send({
      error: {
        message: "套餐并发槽位暂满，请稍后重试",
        type: "rate_limit_error",
        code: "resource_capacity_busy",
        param: null,
        retryable: true,
        retry_after_ms: state.capacityRetryAfterMs,
        request_id: requestId,
      },
    });
    return;
  }
  if (state.halfOpenProbeBusy) {
    await publishFailedRequest(context, state, "UPSTREAM_RATE_LIMITED", "half_open_probe_in_progress");
    reply.code(429).header("retry-after", "1").send({
      error: {
        message: "上游资源正在半开探测，请稍后重试",
        type: "rate_limit_error",
        code: "half_open_probe_in_progress",
        param: null,
        retryable: true,
        retry_after_ms: 1_000,
        request_id: requestId,
      },
    });
    return;
  }
  if (state.quotaExhaustedDuringDispatch) {
    await publishFailedRequest(context, state, "DOWNSTREAM_AUTH_OR_QUOTA", "provider_quota_exhausted");
    const providerName = providerDisplayName(state.quotaExhaustedProviderCode);
    reply.code(429).header("x-request-id", traceId).send({
      error: {
        message: `${providerName}厂商额度已用完，请等待额度重置${state.quotaExhaustedResetAt ? `（${state.quotaExhaustedResetAt}）` : "（下一重置时间未知）"}`,
        type: "rate_limit_error",
        code: "provider_quota_exhausted",
        param: null,
        retryable: false,
        request_id: requestId,
        provider: state.quotaExhaustedProviderCode,
        next_reset_at: state.quotaExhaustedResetAt,
        not_calculable_reason: state.quotaExhaustedResetAt ? null : "PROVIDER_RESET_TIME_UNKNOWN",
      },
    });
    return;
  }
  await publishFailedRequest(context, state, "NO_HEALTHY_CANDIDATE", "no_healthy_candidate");
  reply.code(503).header("x-request-id", traceId).send({
    error: { message: "无可用上游资源", type: "server_error", code: "no_healthy_candidate", param: null, retryable: true, request_id: requestId },
  });
}

function normalizeAssistantOutput(output: unknown[] | undefined): {
  text: string;
  functionCalls: Array<{ callId: string; name: string; arguments: string }>;
} {
  let text = "";
  const functionCalls: Array<{ callId: string; name: string; arguments: string }> = [];
  for (const rawItem of output ?? []) {
    if (typeof rawItem !== "object" || rawItem === null) continue;
    const item = rawItem as Record<string, unknown>;
    if (item.type === "message" && Array.isArray(item.content)) {
      for (const rawPart of item.content) {
        if (
          typeof rawPart === "object"
          && rawPart !== null
          && typeof (rawPart as Record<string, unknown>).text === "string"
        ) {
          text += (rawPart as Record<string, unknown>).text as string;
        }
      }
    }
    if (
      item.type === "function_call"
      && typeof item.call_id === "string"
      && typeof item.name === "string"
      && typeof item.arguments === "string"
    ) {
      functionCalls.push({ callId: item.call_id, name: item.name, arguments: item.arguments });
    }
  }
  return { text, functionCalls };
}

function parseToolArguments(argumentsJson: string): unknown {
  try {
    return JSON.parse(argumentsJson) as unknown;
  } catch {
    return {};
  }
}
