import { Kysely, PostgresDialect } from "kysely";
import { Pool } from "pg";
import type { CredentialChatProbeTable } from "./repositories/credential-chat-probe.js";
import type { AdminRoleTable } from "./kysely-admin-tables.js";
import type {
  DeploymentLogEventTable, DeploymentLogTable, OperatingBillEventTable,
  OperatingBillOpeningBalanceTable, OperatingBillPeriodTable,
  OperatingBillRequestProjectAssignmentTable, OperatingBillValueItemTable,
  OperatingBillVersionTable, OperationLogTable, ProviderModelDiscoveryItemTable,
  ProviderModelDiscoveryTable, ProviderModelOnboardingTable, ProviderModelValidationTable,
  ProviderResourceOperatingSnapshotTable,
} from "./kysely-operations-tables.js";
import type {
  ProviderFinanceDuplicateCandidateTable, ProviderFinanceEventTable, ProviderFinanceIdempotencyTable,
  ProviderFinanceLegacyCostResolutionTable, ProviderFinanceReconciliationCaseTable,
  ProviderSubscriptionPeriodTable,
} from "./kysely-finance-tables.js";
import type {
  EmployeeModelRuleAssignmentTable, EmployeeModelRuleVersionTable, PrincipalModelManualAuthorizationTable,
} from "./employee-model-rule-types.js";
import type {
  AvailabilityEventTable, AvailabilityRuleTable, AvailabilityRuleVersionTable,
  NotificationDeliveryTable, NotificationEndpointTable,
} from "./kysely-availability-tables.js";
import type {
  DirectoryImportItemTable, DirectoryImportRunTable, DirectoryPersonExternalIdentityTable,
  DirectoryPersonTable, DirectorySourceTable, OrganizationMembershipTable, OrganizationUnitTable,
} from "./kysely-directory-tables.js";
import type { ProviderQuotaWindowTable } from "./provider-quota-window-types.js";
import type {
  OperatingBillResourceConfirmationTable, ProjectDepartmentAssignmentTable,
  ProviderResourceOperatingSyncAttemptTable, RequestAttributionSnapshotTable,
  UsageAggregateBucketStateTable, UsageAggregateDirtyBucketTable, UsageBucketAggregateTable,
} from "./kysely-w20-tables.js";
import type {
  AdminSessionTable, AdminUserTable, EmployeeLoginTable, EnterpriseTable,
  KyselyMigrationLockTable, KyselyMigrationTable, PrincipalAccessConfigStateTable,
  PrincipalAccessIdempotencyTable, PrincipalGrantTable, PrincipalKeyTable,
  PrincipalProviderDisabledModelTable, PrincipalTable, QuotaCounterTable,
} from "./kysely-core-tables.js";
import type {
  AlertEventTable, ConcurrencyLeaseTable, DispatchDecisionTable, DispatchPolicyTable,
  ProviderResourceMonthlyBudgetTable, ProviderResourceTable, ProviderTable,
  ReconciliationDiscrepancyTable, ReconciliationRunTable, ResourceStatusEventTable, SupplyForecastTable,
} from "./kysely-resource-tables.js";
import type {
  AiRequestTable, BillingRuleTable, LedgerLineTable, LedgerTransactionTable, ModelRouteTable,
  PrincipalAgentExpectationTable, RouteCandidateTable, UnifiedModelTable, UpstreamAttemptTable,
  UsageEventTable,
} from "./kysely-ledger-tables.js";

export type * from "./kysely-operations-tables.js";
export type * from "./employee-model-rule-types.js";
export type * from "./kysely-availability-tables.js";
export type * from "./kysely-directory-tables.js";
export type * from "./provider-quota-window-types.js";
export type * from "./kysely-w20-tables.js";
export type * from "./kysely-finance-tables.js";
export type * from "./kysely-core-tables.js";
export type * from "./kysely-resource-tables.js";
export type * from "./kysely-ledger-tables.js";

export interface Database {
  credential_chat_probe: CredentialChatProbeTable;
  admin_role: AdminRoleTable;
  kysely_migration: KyselyMigrationTable; kysely_migration_lock: KyselyMigrationLockTable;
  _w01_baseline_probe: { id: number; note: string | null; created_at: Date };
  enterprise: EnterpriseTable; admin_user: AdminUserTable; admin_session: AdminSessionTable;
  employee_login: EmployeeLoginTable; principal: PrincipalTable;
  principal_agent_expectation: PrincipalAgentExpectationTable; person: DirectoryPersonTable;
  person_external_identity: DirectoryPersonExternalIdentityTable; directory_source: DirectorySourceTable;
  organization_unit: OrganizationUnitTable; organization_membership: OrganizationMembershipTable;
  directory_import_run: DirectoryImportRunTable; directory_import_item: DirectoryImportItemTable;
  principal_key: PrincipalKeyTable; principal_grant: PrincipalGrantTable;
  principal_access_idempotency: PrincipalAccessIdempotencyTable;
  principal_access_config_state: PrincipalAccessConfigStateTable;
  principal_provider_disabled_model: PrincipalProviderDisabledModelTable;
  employee_model_rule_version: EmployeeModelRuleVersionTable;
  employee_model_rule_assignment: EmployeeModelRuleAssignmentTable;
  principal_model_manual_authorization: PrincipalModelManualAuthorizationTable;
  quota_counter: QuotaCounterTable; concurrency_lease: ConcurrencyLeaseTable;
  supply_forecast: SupplyForecastTable; dispatch_policy: DispatchPolicyTable;
  dispatch_decision: DispatchDecisionTable; reconciliation_run: ReconciliationRunTable;
  reconciliation_discrepancy: ReconciliationDiscrepancyTable; alert_event: AlertEventTable;
  availability_rule: AvailabilityRuleTable; availability_rule_version: AvailabilityRuleVersionTable;
  availability_event: AvailabilityEventTable; notification_endpoint: NotificationEndpointTable;
  notification_delivery: NotificationDeliveryTable; provider: ProviderTable;
  provider_resource: ProviderResourceTable; provider_resource_monthly_budget: ProviderResourceMonthlyBudgetTable;
  provider_resource_operating_snapshot: ProviderResourceOperatingSnapshotTable;
  provider_resource_operating_sync_attempt: ProviderResourceOperatingSyncAttemptTable;
  provider_finance_event: ProviderFinanceEventTable; provider_subscription_period: ProviderSubscriptionPeriodTable;
  provider_finance_reconciliation_case: ProviderFinanceReconciliationCaseTable;
  provider_finance_idempotency: ProviderFinanceIdempotencyTable;
  provider_finance_duplicate_candidate: ProviderFinanceDuplicateCandidateTable;
  provider_finance_legacy_cost_resolution: ProviderFinanceLegacyCostResolutionTable;
  provider_quota_window: ProviderQuotaWindowTable; provider_model_discovery: ProviderModelDiscoveryTable;
  provider_model_discovery_item: ProviderModelDiscoveryItemTable;
  provider_model_onboarding: ProviderModelOnboardingTable; provider_model_validation: ProviderModelValidationTable;
  resource_status_event: ResourceStatusEventTable; unified_model: UnifiedModelTable; model_route: ModelRouteTable;
  ai_request: AiRequestTable; route_candidate: RouteCandidateTable; upstream_attempt: UpstreamAttemptTable;
  usage_event: UsageEventTable; ledger_line: LedgerLineTable; billing_rule: BillingRuleTable;
  ledger_transaction: LedgerTransactionTable; usage_bucket_aggregate: UsageBucketAggregateTable;
  usage_aggregate_dirty_bucket: UsageAggregateDirtyBucketTable;
  usage_aggregate_bucket_state: UsageAggregateBucketStateTable;
  project_department_assignment: ProjectDepartmentAssignmentTable;
  request_attribution_snapshot: RequestAttributionSnapshotTable; operation_log: OperationLogTable;
  deployment_log: DeploymentLogTable; deployment_log_event: DeploymentLogEventTable;
  operating_bill_period: OperatingBillPeriodTable; operating_bill_value_item: OperatingBillValueItemTable;
  operating_bill_version: OperatingBillVersionTable; operating_bill_event: OperatingBillEventTable;
  operating_bill_request_project_assignment: OperatingBillRequestProjectAssignmentTable;
  operating_bill_opening_balance: OperatingBillOpeningBalanceTable;
  operating_bill_resource_confirmation: OperatingBillResourceConfirmationTable;
}

export function createKysely(databaseUrl?: string): Kysely<Database> {
  const url = databaseUrl ?? process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required (set in .env or process.env)");
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool: new Pool({ connectionString: url }) }) });
}
