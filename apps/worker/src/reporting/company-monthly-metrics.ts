/** User-defined monthly management metrics; no quota-counter deduction or balance clamp. */
export function companyMonthlyMetrics(allocation: string | null, tokens: string, requests: string, allowUndefinedRate = false) {
  if (allocation === null) throw new Error("MONTHLY_ALLOCATION_NOT_PROVABLE");
  const allocated = BigInt(allocation), used = BigInt(tokens), count = BigInt(requests);
  if (allocated < 0n || used < 0n || count < 0n) throw new Error("INVALID_MONTHLY_METRICS");
  const undefinedRate = allocated === 0n && used > 0n;
  if (undefinedRate && !allowUndefinedRate) throw new Error("MONTHLY_USAGE_RATE_UNDEFINED");
  const decimal = (tenths: bigint) => `${tenths / 10n}.${tenths % 10n}`;
  const volume = (value: bigint) => {
    const abs = value < 0n ? -value : value;
    const unit = abs >= 100000000n ? 100000000n : 10000n;
    return `${value < 0n ? "-" : ""}${decimal((abs * 10n + unit / 2n) / unit)} ${unit === 100000000n ? "亿" : "万"}`;
  };
  const rate = allocated === 0n ? 0n : (used * 1000n + allocated / 2n) / allocated;
  return { allocatedTokens: allocation, usedTokens: tokens, remainingTokens: String(allocated - used),
    allocation: volume(allocated), usageRate: undefinedRate ? "—" : `${decimal(rate)}%`, remaining: volume(allocated - used),
    requestsWan: `${decimal((count * 10n + 5000n) / 10000n)} 万` };
}
