/**
 * PostgreSQL Testcontainers 工厂。
 * 镜像与 deploy/compose.yaml 同一 digest（W01 锁定）。
 */
import { PostgreSqlContainer } from "@testcontainers/postgresql";

export interface PostgresTestInstance {
  /** 连接串，供 Kysely/pg Pool 使用。 */
  connectionString: string;
  stop: () => Promise<void>;
}

export async function startPostgresContainer(
  database = "qianliu_test",
  username = "qianliu_test",
  password = "qianliu_test_only",
): Promise<PostgresTestInstance> {
  const container = await new PostgreSqlContainer(
    "postgres:17-alpine@sha256:742f40ea20b9ff2ff31db5458d127452988a2164df9e17441e191f3b72252193",
  )
    .withDatabase(database)
    .withUsername(username)
    .withPassword(password)
    .start();
  const connectionString = container.getConnectionUri();
  return {
    connectionString,
    stop: async () => {
      await container.stop();
    },
  };
}
