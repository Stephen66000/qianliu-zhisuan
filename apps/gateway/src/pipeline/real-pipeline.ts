/**
 * 真实 Gateway 请求编排入口。
 *
 * 具体职责按准入、经营调度、Attempt、结算、北向响应拆分；本文件只负责固定顺序，
 * 以便任何阶段都能独立审阅并保持单文件不超过 400 个逻辑行。
 */
import type { PipelineHandler } from "../routes/chat.js";
import { preparePipelineContext } from "./pipeline-admission.js";
import { runPipelineAttempts } from "./pipeline-attempts.js";
import { sendPipelineResponse } from "./pipeline-response.js";
import { settlePipelineRequest } from "./pipeline-settlement.js";
import { createExecutionState, type RealPipelineDeps } from "./real-pipeline-types.js";

export type { RealPipelineDeps, RouteCandidateRow } from "./real-pipeline-types.js";

export function createRealPipeline(deps: RealPipelineDeps): PipelineHandler {
  const config = {
    maxAttempts: deps.maxAttempts ?? 2,
    capacityWaitMs: deps.capacityWaitMs ?? 2_000,
    capacityPollMs: deps.capacityPollMs ?? 25,
    halfOpenProbeLeaseMs: deps.halfOpenProbeLeaseMs ?? 11 * 60_000,
  };
  if (!Number.isSafeInteger(config.halfOpenProbeLeaseMs) || config.halfOpenProbeLeaseMs <= 0) {
    throw new Error("halfOpenProbeLeaseMs 必须是正整数毫秒");
  }

  return async (input) => {
    const context = await preparePipelineContext(input, deps, config);
    if (!context) return;
    const state = createExecutionState(context);
    if (await runPipelineAttempts(context, state)) return;
    await settlePipelineRequest(context, state);
    await sendPipelineResponse(context, state);
  };
}
