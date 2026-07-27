/**
 * Redis Testcontainers 工厂。
 * 镜像与 deploy/compose.yaml 同一 digest（W01 锁定）。
 */
import { RedisContainer } from "@testcontainers/redis";

export interface RedisTestInstance {
  /** 连接串，供 node-redis 客户端使用。 */
  connectionString: string;
  stop: () => Promise<void>;
}

export async function startRedisContainer(): Promise<RedisTestInstance> {
  const container = await new RedisContainer(
    "redis:8-alpine@sha256:8096655e437712b07503796fb64d81359256cfcff0ab29d95a7da72863786efb",
  ).start();
  const connectionString = container.getConnectionUrl();
  return {
    connectionString,
    stop: async () => {
      await container.stop();
    },
  };
}
