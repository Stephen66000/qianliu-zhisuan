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
