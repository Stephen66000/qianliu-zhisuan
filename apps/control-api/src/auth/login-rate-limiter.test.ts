import { describe, expect, it } from "vitest";
import { LoginRateLimiter } from "./login-rate-limiter.js";

function createLimiter(maxBuckets = 3): LoginRateLimiter {
  return new LoginRateLimiter({ maxAttempts: 2, windowMs: 1_000, maxBuckets });
}

describe("LoginRateLimiter", () => {
  it("拒绝无效配置", () => {
    expect(() => new LoginRateLimiter({ maxAttempts: 0, windowMs: 1, maxBuckets: 1 })).toThrow();
  });

  it("达到失败次数后拦截，成功登录可清除", () => {
    const limiter = createLimiter();
    limiter.recordFailure("ip:user", 0);
    limiter.recordFailure("ip:user", 1);
    expect(limiter.isBlocked("ip:user", 2)).toBe(true);
    limiter.clear("ip:user");
    expect(limiter.isBlocked("ip:user", 3)).toBe(false);
  });

  it("窗口过期后回收计数", () => {
    const limiter = createLimiter();
    limiter.recordFailure("ip:user", 0);
    expect(limiter.isBlocked("ip:user", 1_000)).toBe(false);
    expect(limiter.size).toBe(0);
  });

  it("随机用户名数量超过上限时淘汰最旧桶", () => {
    const limiter = createLimiter(2);
    limiter.recordFailure("ip:user-1", 0);
    limiter.recordFailure("ip:user-2", 1);
    limiter.recordFailure("ip:user-3", 2);
    expect(limiter.size).toBe(2);
    expect(limiter.isBlocked("ip:user-1", 3)).toBe(false);
  });
});
