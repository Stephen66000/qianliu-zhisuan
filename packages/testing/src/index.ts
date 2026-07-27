/**
 * @qianliu/testing — 跨包夹具：PG/Redis Testcontainers 工厂与 canary 辅助。
 *
 * W01 提供启动容器与清理的工厂；集成测试在各包的 __tests-integration__ 中调用。
 * 镜像 digest 与 deploy/compose.yaml 一致（工程规则 §2 digest 锁定）。
 */
export { startPostgresContainer, type PostgresTestInstance } from "./postgres-container.js";
export { startRedisContainer, type RedisTestInstance } from "./redis-container.js";

export const TESTING_VERSION = "0.3.0" as const;
