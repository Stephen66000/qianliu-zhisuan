import { hasImageInput, modelSupportsImages, MODEL_IMAGE_UNSUPPORTED } from "@qianliu/provider-adapters";
import type { ClaimRequestResult, AvailabilityEvent } from "@qianliu/database";
import { identifyClient, type RoutingCandidateInput } from "@qianliu/domain";
import { createChatStreamWriter, type GatewayStreamWriter } from "../routes/chat-protocol.js";
import { createMessagesStreamWriter } from "../routes/messages-protocol.js";
import type { PipelineHandler } from "../routes/chat.js";
import { sendModelNotAllowed } from "../auth/principal-auth.js";
import { fingerprintRequest } from "./request-idempotency.js";
import { resolveRequestModelIdentity } from "./request-model-identity.js";
import { buildEffectiveBody } from "./history-truncation.js";
import { sendRuntimeBlock } from "./runtime-controls.js";
import {
  invocationCandidateKey,
  type PipelineContext,
  type RealPipelineDeps,
  type RouteCandidateRow,
} from "./real-pipeline-types.js";

export interface PipelineConfig {
  maxAttempts: number;
  capacityWaitMs: number;
  capacityPollMs: number;
  halfOpenProbeLeaseMs: number;
}

export async function preparePipelineContext(
  input: Parameters<PipelineHandler>[0],
  deps: RealPipelineDeps,
  config: PipelineConfig,
): Promise<PipelineContext | null> {
  const { request, reply, body, capability } = input;
  const requestId = request.aiRequestId;
  const traceId = request.requestId;
  const principal = request.principal!;
  const modelIdentity = resolveRequestModelIdentity(principal, body.model);
  if (!modelIdentity) {
    sendModelNotAllowed(reply, request, body.model);
    return null;
  }
  const downstreamAbort = new AbortController();
  request.raw.once("aborted", () => downstreamAbort.abort());
  reply.raw.once("close", () => {
    if (!reply.raw.writableEnded) downstreamAbort.abort();
  });
  const requestStartedAt = deps.now?.() ?? Date.now();
  const created = Math.floor(requestStartedAt / 1000);
  const requestFingerprint = request.idempotencyKey
    ? fingerprintRequest(capability, body)
    : null;
  const client = identifyClient({
    headers: request.headers,
    protocol: capability,
    url: request.url,
  });

  const claim = await deps.ledgerRepo.claimRequest({
    id: requestId,
    enterprise_id: principal.enterpriseId,
    principal_id: principal.principalId,
    principal_key_id: principal.keyId,
    idempotency_key: request.idempotencyKey,
    client_request_id: traceId,
    request_fingerprint: requestFingerprint,
    protocol: capability,
    ...modelIdentity,
    stream: body.stream ?? false,
    client_id: client.rawClientId,
    agent_family: client.family,
    agent_version: client.version,
    agent_identity_source: client.source,
    agent_identity_confidence: client.confidence,
    client_identity_rule_version: client.ruleVersion,
  });
  if (claim.kind !== "CREATED") {
    sendIdempotencyReplay(reply, traceId, claim);
    return null;
  }
  reply.header("x-request-id", traceId);
  reply.header("x-ai-request-id", requestId);
  const streamWriter: GatewayStreamWriter | null = body.stream && capability === "chat"
    ? createChatStreamWriter(reply, { requestId, traceId, createdAt: created, model: body.model })
    : body.stream && capability === "messages"
      ? createMessagesStreamWriter(reply, { requestId, traceId, model: body.model })
      : null;

  const allCandidates = await deps.listCandidates(principal.enterpriseId, body.model);
  if (allCandidates.length === 0) {
    await deps.ledgerRepo.updateRequestStatus(requestId, "FAILED", "MODEL_NOT_FOUND", "model_not_configured");
    reply.code(404).send({
      error: { message: "模型未配置", type: "invalid_request_error", code: "model_not_configured", param: "model", retryable: false, request_id: requestId },
    });
    return null;
  }
  const grantChecks = await Promise.all(
    allCandidates.map(async (candidate) => ({
      candidate,
      authorized: await deps.quotaRepo.hasActiveGrant({
        enterpriseId: principal.enterpriseId,
        principalId: principal.principalId,
        provider: candidate.providerCode,
        modelAlias: body.model,
      }),
    })),
  );
  const grantAuthorizedCandidates = grantChecks
    .filter((result) => result.authorized)
    .map((result) => result.candidate);
  if (grantAuthorizedCandidates.length === 0) {
    await deps.ledgerRepo.updateRequestStatus(
      requestId, "FAILED", "DOWNSTREAM_AUTH_OR_QUOTA", "principal_grant_required",
    );
    reply.code(403).header("x-request-id", traceId).send({
      error: {
        message: "主体未获该模型的有效资源授权",
        type: "authentication_error",
        code: "principal_grant_required",
        param: "model",
        retryable: false,
        request_id: requestId,
      },
    });
    return null;
  }

  // Before truncation, quota reservation or any upstream invocation; use exact routed models.
  const containsImages = hasImageInput(body);
  const imageCompatibleCandidates = grantAuthorizedCandidates.filter((candidate) =>
    !containsImages || modelSupportsImages(candidate.providerCode, candidate.upstreamModel) !== false);
  if (imageCompatibleCandidates.length === 0) {
    await deps.ledgerRepo.updateRequestStatus(requestId, "FAILED", "CLIENT_INVALID", MODEL_IMAGE_UNSUPPORTED);
    reply.code(400).send({ error: {
      message: "模型不支持图片", type: "invalid_request_error", code: MODEL_IMAGE_UNSUPPORTED,
      param: "model", retryable: false, request_id: requestId,
    } });
    return null;
  }

  const servableById = new Map(
    (await deps.poolRepo.listServableResources(principal.enterpriseId)).map((resource) => [resource.id, resource]),
  );
  const candidateByInvocationKey = new Map(
    imageCompatibleCandidates.map((candidate) => [invocationCandidateKey(candidate), candidate]),
  );
  let blockingEvent: AvailabilityEvent | null = null;
  const runtimeAllowedCandidates: RouteCandidateRow[] = [];
  for (const candidate of imageCompatibleCandidates) {
    if (deps.runtimeAssuranceRepo && deps.runtimeAssuranceMode === "ENFORCE") {
      const open = await deps.runtimeAssuranceRepo.findOpenBlock(candidate.resourceId, candidate.upstreamModel);
      if (open) {
        blockingEvent ??= open;
        continue;
      }
      if (candidate.providerId) {
        const schedule = await deps.runtimeAssuranceRepo.evaluateSchedule({
          now: new Date(requestStartedAt),
          providerId: candidate.providerId,
          providerResourceId: candidate.resourceId,
          unifiedModelId: candidate.unifiedModelId ?? null,
          upstreamModel: candidate.upstreamModel,
        });
        if (schedule?.action === "BLOCK") {
          blockingEvent = await deps.runtimeAssuranceRepo.createScheduleEvent({
            rule: schedule,
            enterpriseId: principal.enterpriseId,
            providerId: candidate.providerId,
            providerResourceId: candidate.resourceId,
            unifiedModelId: candidate.unifiedModelId ?? null,
            upstreamModel: candidate.upstreamModel,
            aiRequestId: requestId,
            principalId: principal.principalId,
            now: new Date(requestStartedAt),
            wecomNotify: deps.runtimeAssuranceWecomNotify ?? false,
          });
          continue;
        }
      }
    }
    if (!servableById.has(candidate.resourceId)) continue;
    runtimeAllowedCandidates.push(candidate);
  }
  const eligible: RoutingCandidateInput[] = runtimeAllowedCandidates.map((candidate) => {
    const admission = servableById.get(candidate.resourceId)!;
    return {
      routeId: candidate.routeId,
      resourceId: candidate.resourceId,
      upstreamModel: candidate.upstreamModel,
      priority: candidate.priority,
      weight: candidate.weight,
      status: admission.status as RoutingCandidateInput["status"],
      probe: admission.probe,
      mode: candidate.mode,
      providerCode: candidate.providerCode,
    };
  });

  if (eligible.length === 0) {
    await sendNoEligibleResponse({
      deps, reply, capability, traceId, requestId, principalEnterpriseId: principal.enterpriseId,
      blockingEvent, grantAuthorizedCandidates,
    });
    return null;
  }
  const affinityResourceId = deps.resolveAffinity
    ? await deps.resolveAffinity(principal.principalId, body.model)
    : null;
  return {
    deps,
    request,
    reply,
    body,
    capability,
    requestId,
    traceId,
    principal,
    principalId: principal.principalId,
    requestStartedAt,
    created,
    streamWriter,
    downstreamAbort,
    effectiveBody: containsImages ? body : buildEffectiveBody(
      body, capability, deps.truncationConfig ?? null, request.log, requestId,
    ),
    eligible,
    candidateByInvocationKey,
    affinityResourceId,
    ...config,
  };
}

async function sendNoEligibleResponse(input: {
  deps: RealPipelineDeps;
  reply: Parameters<PipelineHandler>[0]["reply"];
  capability: Parameters<PipelineHandler>[0]["capability"];
  traceId: string;
  requestId: string;
  principalEnterpriseId: string;
  blockingEvent: AvailabilityEvent | null;
  grantAuthorizedCandidates: RouteCandidateRow[];
}): Promise<void> {
  if (input.blockingEvent) {
    await input.deps.ledgerRepo.updateRequestStatus(
      input.requestId, "FAILED", "RUNTIME_ASSURANCE_BLOCKED", input.blockingEvent.event_number,
    );
    sendRuntimeBlock(input.reply, input.capability, input.traceId, input.requestId, input.blockingEvent);
    return;
  }
  const coolingResources = await Promise.all(
    input.grantAuthorizedCandidates.map((candidate) => input.deps.poolRepo.getResource(candidate.resourceId)),
  );
  const resource = coolingResources.find((candidate) => candidate?.status === "RATE_LIMITED");
  if (resource) {
    const retryAfterMs = Math.max(
      1_000,
      (resource.cooldown_until?.getTime() ?? Date.now() + 1_000) - Date.now(),
    );
    await input.deps.ledgerRepo.updateRequestStatus(
      input.requestId, "FAILED", "UPSTREAM_RATE_LIMITED", "resource_rate_limited",
    );
    input.reply.code(429).header("retry-after", Math.max(1, Math.ceil(retryAfterMs / 1_000))).send({
      error: {
        message: "上游资源正在限流冷却，请稍后重试",
        type: "rate_limit_error",
        code: "resource_rate_limited",
        param: null,
        retryable: true,
        retry_after_ms: retryAfterMs,
        request_id: input.requestId,
      },
    });
    return;
  }
  await input.deps.ledgerRepo.updateRequestStatus(
    input.requestId, "FAILED", "NO_HEALTHY_CANDIDATE", "no_healthy_candidate",
  );
  input.reply.code(503).send({
    error: { message: "无可用上游资源", type: "server_error", code: "no_healthy_candidate", param: null, retryable: true, request_id: input.requestId },
  });
}

function sendIdempotencyReplay(
  reply: Parameters<PipelineHandler>[0]["reply"],
  traceId: string,
  claim: Exclude<ClaimRequestResult, { kind: "CREATED" }>,
): void {
  const original = claim.request;
  reply.header("x-request-id", traceId);
  reply.header("x-ai-request-id", original.id);
  if (claim.kind === "CONFLICT") {
    reply.code(409).send({
      error: {
        message: "同一 Idempotency-Key 已用于不同请求体",
        type: "invalid_request_error",
        code: "idempotency_key_conflict",
        param: "Idempotency-Key",
        retryable: false,
        request_id: original.id,
      },
    });
    return;
  }
  const replay = idempotencyReplayState(original.status);
  reply.code(409).send({
    error: {
      message: replay.message,
      type: "invalid_request_error",
      code: replay.code,
      param: "Idempotency-Key",
      retryable: replay.retryable,
      request_id: original.id,
      original_status: original.status,
      original_error_code: original.error_code,
    },
  });
}

function idempotencyReplayState(status: string) {
  if (status === "PENDING" || status === "IN_PROGRESS") {
    return { code: "idempotency_request_in_progress", message: "相同幂等请求正在处理中", retryable: true };
  }
  if (status === "SUCCEEDED") {
    return {
      code: "idempotency_request_succeeded",
      message: "相同幂等请求已成功完成；响应正文未持久化，请使用新的 Idempotency-Key 发起新请求",
      retryable: false,
    };
  }
  return {
    code: "idempotency_request_failed",
    message: "相同幂等请求已终止；请使用新的 Idempotency-Key 发起新请求",
    retryable: false,
  };
}
