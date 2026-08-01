interface LoginAttemptBucket {
  count: number;
  windowStart: number;
}

export interface LoginRateLimiterOptions {
  maxAttempts: number;
  windowMs: number;
  maxBuckets: number;
}

/**
 * 有界的登录失败计数器。
 *
 * 过期桶会在访问时回收；达到容量时淘汰最旧桶，避免攻击者用随机用户名耗尽内存。
 */
export class LoginRateLimiter {
  readonly #buckets = new Map<string, LoginAttemptBucket>();

  constructor(private readonly options: LoginRateLimiterOptions) {
    if (options.maxAttempts < 1 || options.windowMs < 1 || options.maxBuckets < 1) {
      throw new Error("登录限速参数必须是正整数");
    }
  }

  isBlocked(key: string, now: number): boolean {
    this.#pruneExpired(now);
    const bucket = this.#buckets.get(key);
    return bucket !== undefined && bucket.count >= this.options.maxAttempts;
  }

  recordFailure(key: string, now: number): void {
    this.#pruneExpired(now);
    const existing = this.#buckets.get(key);
    if (existing) {
      existing.count += 1;
      return;
    }
    if (this.#buckets.size >= this.options.maxBuckets) {
      const oldestKey = this.#buckets.keys().next().value as string | undefined;
      if (oldestKey !== undefined) this.#buckets.delete(oldestKey);
    }
    this.#buckets.set(key, { count: 1, windowStart: now });
  }

  clear(key: string): void {
    this.#buckets.delete(key);
  }

  get size(): number {
    return this.#buckets.size;
  }

  #pruneExpired(now: number): void {
    for (const [key, bucket] of this.#buckets) {
      if (now - bucket.windowStart >= this.options.windowMs) {
        this.#buckets.delete(key);
      } else {
        // Map 按新桶插入时间有序；遇到未过期桶后，其余桶也无需扫描。
        break;
      }
    }
  }
}
