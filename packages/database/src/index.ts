/**
 * @qianliu/database — Kysely dialect、Schema 类型、迁移框架入口与仓储。
 *
 * 工程规则 §2 行 35：迁移文件为 Schema 唯一变更入口。
 * TRD §4：Kysely 0.28.7 + pg 8.16.3；金额字段使用 PostgreSQL numeric + decimal.js。
 */
export { createKysely, type Database } from "./kysely.js";
export {
  MIGRATIONS_PATH,
  listMigrations,
  migrateToLatest,
  migrateDown,
} from "./migrator.js";
export {
  PrincipalRepository,
  type Principal,
  type CreatePrincipalInput,
  type UpdatePrincipalInput,
} from "./repositories/principal-repository.js";
export {
  AuditRepository,
  type OperationLog,
  type WriteAuditInput,
} from "./repositories/audit-repository.js";
export {
  AdminRepository,
  type AdminUser,
  type AdminSession,
} from "./repositories/admin-repository.js";
export {
  KeyRepository,
  type PrincipalKey,
  type CreatedKey,
} from "./repositories/key-repository.js";
export {
  GrantRepository,
  type PrincipalGrant,
  type CreateGrantInput,
} from "./repositories/grant-repository.js";
export {
  ProviderRepository,
  type Provider,
  type ProviderResource,
  type UnifiedModel,
  type ModelRoute,
  type CreateProviderInput,
  type CreateProviderResourceInput,
} from "./repositories/provider-repository.js";
export {
  GatewayLedgerRepository,
  type AiRequest,
  type UpstreamAttempt,
  type UsageEvent,
  type LedgerLine,
  type LedgerTransaction,
  type RouteCandidate,
  type CreateRequestInput,
  type CreateAttemptInput,
  type UsageInput,
  type LedgerLineInput,
} from "./repositories/gateway-ledger-repository.js";
export {
  ResourcePoolRepository,
  type ResourceStatusEvent,
  type ProviderResourceRow,
  type ServableResource,
} from "./repositories/resource-pool-repository.js";
export {
  QuotaGateRepository,
  type QuotaReserveOutcome,
} from "./repositories/quota-gate-repository.js";
export {
  DispatchPolicyRepository,
  type CreateDispatchPolicyInput,
  type CreateDispatchDecisionInput,
} from "./repositories/dispatch-policy-repository.js";
export {
  ReconciliationRepository,
  type ReconciliationRunInput,
  type ReconciliationOutcome,
} from "./repositories/reconciliation-repository.js";

export const DATABASE_VERSION = "0.3.0" as const;
