import type { createClient } from "redis";

export type RedisClientType = ReturnType<typeof createClient>;

export interface MilestoneStore {
  hasTop1IssuedToday(enterpriseId: string, dateStr: string): Promise<boolean>;
  recordTop1IssuedToday(enterpriseId: string, dateStr: string): Promise<void>;
  hasUserAwardedTop1ThisWeek(enterpriseId: string, weekStr: string, userId: string): Promise<boolean>;
  recordUserAwardedTop1ThisWeek(enterpriseId: string, weekStr: string, userId: string): Promise<void>;
  hasUserAwardedOver50ThisMonth(enterpriseId: string, monthStr: string, userId: string): Promise<boolean>;
  recordUserAwardedOver50ThisMonth(enterpriseId: string, monthStr: string, userId: string): Promise<void>;
}

/**
 * 内存版 MilestoneStore（用于单机测试或无 Redis 容器降级）
 */
export class MemoryMilestoneStore implements MilestoneStore {
  private dailyTop1Issued = new Set<string>();
  private weeklyTop1Users = new Map<string, Set<string>>();
  private monthlyOver50Users = new Map<string, Set<string>>();

  async hasTop1IssuedToday(enterpriseId: string, dateStr: string): Promise<boolean> {
    return this.dailyTop1Issued.has(`${enterpriseId}:${dateStr}`);
  }

  async recordTop1IssuedToday(enterpriseId: string, dateStr: string): Promise<void> {
    this.dailyTop1Issued.add(`${enterpriseId}:${dateStr}`);
  }

  async hasUserAwardedTop1ThisWeek(enterpriseId: string, weekStr: string, userId: string): Promise<boolean> {
    const key = `${enterpriseId}:${weekStr}`;
    return this.weeklyTop1Users.get(key)?.has(userId) ?? false;
  }

  async recordUserAwardedTop1ThisWeek(enterpriseId: string, weekStr: string, userId: string): Promise<void> {
    const key = `${enterpriseId}:${weekStr}`;
    if (!this.weeklyTop1Users.has(key)) {
      this.weeklyTop1Users.set(key, new Set());
    }
    this.weeklyTop1Users.get(key)!.add(userId);
  }

  async hasUserAwardedOver50ThisMonth(enterpriseId: string, monthStr: string, userId: string): Promise<boolean> {
    const key = `${enterpriseId}:${monthStr}`;
    return this.monthlyOver50Users.get(key)?.has(userId) ?? false;
  }

  async recordUserAwardedOver50ThisMonth(enterpriseId: string, monthStr: string, userId: string): Promise<void> {
    const key = `${enterpriseId}:${monthStr}`;
    if (!this.monthlyOver50Users.has(key)) {
      this.monthlyOver50Users.set(key, new Set());
    }
    this.monthlyOver50Users.get(key)!.add(userId);
  }
}

/**
 * Redis 版 MilestoneStore（支持集群分布式频控）
 */
export class RedisMilestoneStore implements MilestoneStore {
  constructor(private readonly redis: RedisClientType) {}

  async hasTop1IssuedToday(enterpriseId: string, dateStr: string): Promise<boolean> {
    const key = `milestone:top1:issued:${enterpriseId}:${dateStr}`;
    const val = await this.redis.get(key);
    return Boolean(val);
  }

  async recordTop1IssuedToday(enterpriseId: string, dateStr: string): Promise<void> {
    const key = `milestone:top1:issued:${enterpriseId}:${dateStr}`;
    await this.redis.set(key, "1", { EX: 86400 * 2 }); // 保留2天
  }

  async hasUserAwardedTop1ThisWeek(enterpriseId: string, weekStr: string, userId: string): Promise<boolean> {
    const key = `milestone:top1:users:${enterpriseId}:${weekStr}`;
    return Boolean(await this.redis.sIsMember(key, userId));
  }

  async recordUserAwardedTop1ThisWeek(enterpriseId: string, weekStr: string, userId: string): Promise<void> {
    const key = `milestone:top1:users:${enterpriseId}:${weekStr}`;
    await this.redis.sAdd(key, userId);
    await this.redis.expire(key, 86400 * 14); // 保留14天
  }

  async hasUserAwardedOver50ThisMonth(enterpriseId: string, monthStr: string, userId: string): Promise<boolean> {
    const key = `milestone:over50:users:${enterpriseId}:${monthStr}`;
    return Boolean(await this.redis.sIsMember(key, userId));
  }

  async recordUserAwardedOver50ThisMonth(enterpriseId: string, monthStr: string, userId: string): Promise<void> {
    const key = `milestone:over50:users:${enterpriseId}:${monthStr}`;
    await this.redis.sAdd(key, userId);
    await this.redis.expire(key, 86400 * 45); // 保留45天
  }
}
