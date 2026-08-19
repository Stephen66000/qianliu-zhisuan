export async function runScheduledOperationalTasks<T>(input: {
  core: () => Promise<T>;
  aggregate: () => Promise<unknown>;
  onAggregateError?: (cause: unknown) => void;
}): Promise<{ core: T; aggregate: unknown | null }> {
  const core = await input.core();
  try {
    return { core, aggregate: await input.aggregate() };
  } catch (cause) {
    input.onAggregateError?.(cause);
    return { core, aggregate: null };
  }
}
