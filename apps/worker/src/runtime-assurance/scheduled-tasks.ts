export async function runScheduledOperationalTasks<T>(input: {
  core: () => Promise<T>;
  renewals?: () => Promise<unknown>;
  onRenewalError?: (cause: unknown) => void;
  aggregate: () => Promise<unknown>;
  onAggregateError?: (cause: unknown) => void;
}): Promise<{ core: T; aggregate: unknown | null }> {
  if (input.renewals) {
    try { await input.renewals(); } catch (cause) { if (input.onRenewalError) input.onRenewalError(cause); else throw cause; }
  }
  const core = await input.core();
  try {
    return { core, aggregate: await input.aggregate() };
  } catch (cause) {
    input.onAggregateError?.(cause);
    return { core, aggregate: null };
  }
}

/**
 * CPQW（计划§8）：单个必需任务的独立捕错——失败记录后返回 null，不阻止
 * 同轮其他任务（前置失败仍尝试 quota）；调用方在全部任务尝试完成后汇总，
 * 任一失败则整轮标失败并反映到调度健康，不以 catch 伪装成功。
 */
export async function runIsolatedOperationalTask<T>(
  task: string,
  work: () => Promise<T>,
  onTaskError: (task: string, cause: unknown) => void,
): Promise<T | null> {
  try {
    return await work();
  } catch (error) {
    onTaskError(task, error);
    return null;
  }
}

/** 全部必需任务尝试完成后的整轮汇总：有失败则抛出（调度健康降级），否则返回结果。 */
export function summarizeIsolatedOperationalRound<T>(
  results: T,
  failures: readonly string[],
): T {
  if (failures.length > 0) {
    throw new Error(`operational_tick_partial_failure:${failures.join(",")}`);
  }
  return results;
}
