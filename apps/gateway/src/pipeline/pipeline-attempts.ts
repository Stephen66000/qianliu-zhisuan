import { pickWinner, scoreAndSelect } from "@qianliu/domain";
import { executeSelectedAttempt } from "./pipeline-attempt-execution.js";
import { applyInitialDispatchDecision } from "./pipeline-dispatch-decision.js";
import type { PipelineContext, PipelineExecutionState } from "./real-pipeline-types.js";

/** 多候选评分与有界提交前切换。返回 true 表示响应已在循环内完成。 */
export async function runPipelineAttempts(
  context: PipelineContext,
  state: PipelineExecutionState,
): Promise<boolean> {
  while (state.attemptNo < context.maxAttempts) {
    state.attemptNo += 1;
    state.lastScored = scoreAndSelect(
      state.routeEligibleCandidates,
      context.affinityResourceId,
      state.triedResourceIds,
    );
    state.winner = pickWinner(state.lastScored);
    if (state.dispatchRecheckTarget) {
      const forced = state.lastScored.find((item) => item.input.resourceId === state.dispatchRecheckTarget);
      state.dispatchRecheckTarget = undefined;
      if (forced) {
        if (state.winner) state.winner.selected = false;
        forced.selected = true; state.winner = forced;
      }
    }
    if (!state.winner) break;

    await applyInitialDispatchDecision(context, state);
    if (state.dispatchTerminated) break;

    const result = await executeSelectedAttempt(context, state);
    if (result === "RETURNED") return true;
    if (result === "BREAK") break;
  }
  return false;
}
