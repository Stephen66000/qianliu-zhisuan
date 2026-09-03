/**
 * @qianliu/control-api —— 控制平面与管理 API 构建器（W02）。
 *
 * buildControlApi(db) 同步注册所有插件与路由，返回 Fastify 实例。
 * 测试直接调用此函数；生产入口在 main.ts。
 *
 * 安全：HttpOnly+Secure+SameSite Cookie；严格 CORS（TRD §14.2）。
 */
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import type { Kysely } from "kysely";
import type { Database } from "@qianliu/database";
import {
  PrincipalRepository,
  AuditRepository,
  AdminRepository,
  KeyRepository,
  GrantRepository,
  ProviderRepository,
  DashboardRepository,
  UsageRepository,
  GatewayLedgerRepository,
  DispatchPolicyRepository,
  AdminWriteRepository,
  AlertEventRepository,
  RuntimeAssuranceRepository,
  OperatingBillRepository,
  OperatingBillAccountRepository,
  DeploymentLogRepository,
  EmployeeModelRuleRepository,
  PrincipalAccessConfigRepository,
  ProviderQuotaWindowRepository,
  ProviderFinanceRepository,
  ResourcePoolRepository,
  DEFAULT_THRESHOLDS,
  type AlertThresholds,
} from "@qianliu/database";
import {
  generateApiKey,
  digestApiKey,
  apiKeyPrefix,
  decodeKek,
} from "@qianliu/provider-adapters";
import { registerAuthRoutes } from "./auth/routes.js";
import { registerPrincipalRoutes } from "./principals/routes.js";
import { registerPrincipalAccessConfigRoutes } from "./principals/access-configuration.js";
import { registerAuditRoutes } from "./plugins/audit-routes.js";
import { registerKeyRoutes } from "./keys/routes.js";
import { registerGrantRoutes } from "./grants/routes.js";
import { registerProviderRoutes } from "./providers/routes.js";
import { registerDashboardRoutes } from "./dashboard/routes.js";
import { registerUsageRoutes } from "./usage/routes.js";
import { registerReadModelRoutes } from "./read-models/routes.js";
import { registerAdminWriteRoutes } from "./admin-writes/routes.js";
import { registerGatewayRequestRoutes } from "./gateway-requests/routes.js";
import { registerAlertRoutes } from "./alerts/routes.js";
import { registerRuntimeAssuranceRoutes } from "./runtime-assurance/routes.js";
import { registerAdminRoutes } from "./admins/routes.js";
import { registerOperatingBillRoutes } from "./operating-bills/routes.js";
import { registerOperatingBillAccountRoutes } from "./operating-bills/account-routes.js";
import { registerDeploymentLogRoutes } from "./deployment-logs/routes.js";
import { registerEmployeeModelRuleRoutes } from "./employee-model-rules/routes.js";
import { registerResourceInsightRoutes } from "./resource-insights/routes.js";
import { registerEnterpriseSettingsRoutes } from "./enterprise-settings/routes.js";
import { registerDepartmentCostRoutes } from "./department-costs/routes.js";
import { registerDirectoryRoutes } from "./directory/routes.js";
import { registerProviderFinanceRoutes } from "./provider-finance/routes.js";
import { configuredWebOrigins, isCrossSiteMutation } from "./security/origin-policy.js";
import {
  readFeatureFlags,
  readProviderFinanceMode,
  readPositiveIntEnv,
  type FeatureFlags,
  type ProviderFinanceMode,
} from "@qianliu/config";

/** 已认证管理员的请求上下文（auth-guard 注入）。 */
export interface AdminContext {
  adminUserId: string;
  enterpriseId: string;
  username: string;
  displayName: string;
  mustChangePassword: boolean;
}

declare module "fastify" {
  interface FastifyRequest {
    admin?: AdminContext;
  }
  interface FastifyInstance {
    db: Kysely<Database>;
    principalRepo: PrincipalRepository;
    auditRepo: AuditRepository;
    adminRepo: AdminRepository;
    keyRepo: KeyRepository;
    grantRepo: GrantRepository;
    providerRepo: ProviderRepository;
    credentialKek: Buffer;
    dashboardRepo: DashboardRepository;
    usageRepo: UsageRepository;
    ledgerRepo: GatewayLedgerRepository;
    dispatchRepo: DispatchPolicyRepository;
    adminWriteRepo: AdminWriteRepository;
    alertEventRepo: AlertEventRepository;
    runtimeAssuranceRepo: RuntimeAssuranceRepository;
    operatingBillRepo: OperatingBillRepository;
    operatingBillAccountRepo: OperatingBillAccountRepository;
    deploymentLogRepo: DeploymentLogRepository;
    employeeModelRuleRepo: EmployeeModelRuleRepository;
    principalAccessConfigRepo: PrincipalAccessConfigRepository;
    quotaWindowRepo: ProviderQuotaWindowRepository;
    providerFinanceRepo: ProviderFinanceRepository;
    poolRepo: ResourcePoolRepository;
    featureFlags: FeatureFlags;
    providerFinanceMode: ProviderFinanceMode;
  }
}

/**
 * 入站请求体上限（字节）。Fastify 默认仅 1MB，账单快照导入、部署清单导入等
 * bulk 端点在大批量场景会超限（FST_ERR_CTP_BODY_TOO_LARGE → 413）。
 * 默认 10MB；可通过 CONTROL_API_REQUEST_BODY_LIMIT_BYTES 覆盖。
 * H-1：校验逻辑复用 @qianliu/config 的 readPositiveIntEnv（与 gateway 共享，防漂移）。
 */
const REQUEST_BODY_LIMIT_DEFAULT = 10 * 1024 * 1024;

export function readRequestBodyLimit(env: NodeJS.ProcessEnv): number {
  return readPositiveIntEnv(env, "CONTROL_API_REQUEST_BODY_LIMIT_BYTES", REQUEST_BODY_LIMIT_DEFAULT, "字节");
}

export interface ControlApiOptions {
  port?: number;
  host?: string;
}

function alertThresholdsFromEnv(env: NodeJS.ProcessEnv): AlertThresholds {
  const numberValue = (
    name: string,
    fallback: number,
    minimum: number,
    maximum = Number.POSITIVE_INFINITY,
  ): number => {
    const raw = env[name];
    if (raw === undefined) return fallback;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < minimum || value > maximum) {
      throw new Error(`${name} 必须是 ${minimum}~${maximum} 的有限数字`);
    }
    return value;
  };
  return {
    exhaustCoverageHours: numberValue(
      "ALERT_EXHAUST_COVERAGE_HOURS",
      DEFAULT_THRESHOLDS.exhaustCoverageHours,
      0,
    ),
    usageSpikeCost: numberValue(
      "ALERT_USAGE_SPIKE_COST",
      DEFAULT_THRESHOLDS.usageSpikeCost,
      0,
    ),
    principalQuotaRatio: numberValue(
      "ALERT_PRINCIPAL_QUOTA_RATIO",
      DEFAULT_THRESHOLDS.principalQuotaRatio,
      0,
      1,
    ),
    resourceFailureCount: numberValue(
      "ALERT_RESOURCE_FAILURE_COUNT",
      DEFAULT_THRESHOLDS.resourceFailureCount,
      1,
    ),
  };
}

export function buildControlApi(db: Kysely<Database>, _opts: ControlApiOptions = {}): FastifyInstance {
  const featureFlags = readFeatureFlags(process.env);
  const providerFinanceMode = readProviderFinanceMode(process.env);
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? "info" },
    // W24：反代（Caddy/nginx）终止 TLS 时，信任 X-Forwarded-* 以正确判定协议/主机（影响 Cookie secure）。
    trustProxy: process.env.NODE_ENV === "production",
    // 入站 bodyLimit：默认 1MB 对 bulk import 端点有风险。
    bodyLimit: readRequestBodyLimit(process.env),
  });

  app.decorate("db", db);
  app.decorate("principalRepo", new PrincipalRepository(db));
  app.decorate("auditRepo", new AuditRepository(db));
  app.decorate("adminRepo", new AdminRepository(db));
  app.decorate(
    "keyRepo",
    new KeyRepository(
      db,
      // F-02：dev fallback 仅测试态可达；生产入口 main.ts 已用 requireEnv 拦截缺失
      process.env.GATEWAY_KEY_PEPPER ?? "dev-only-pepper",
      generateApiKey,
      digestApiKey,
      apiKeyPrefix,
    ),
  );
  app.decorate("grantRepo", new GrantRepository(db));
  app.decorate("providerRepo", new ProviderRepository(db));
  app.decorate("dashboardRepo", new DashboardRepository(db));
  app.decorate("usageRepo", new UsageRepository(db));
  app.decorate("ledgerRepo", new GatewayLedgerRepository(db));
  app.decorate("dispatchRepo", new DispatchPolicyRepository(db));
  app.decorate("adminWriteRepo", new AdminWriteRepository(db));
  app.decorate(
    "alertEventRepo",
    new AlertEventRepository(
      db,
      alertThresholdsFromEnv(process.env),
      featureFlags.FEATURE_DEPARTMENT_COST,
    ),
  );
  app.decorate("runtimeAssuranceRepo", new RuntimeAssuranceRepository(db));
  app.decorate("operatingBillRepo", new OperatingBillRepository(db, providerFinanceMode));
  app.decorate("operatingBillAccountRepo", new OperatingBillAccountRepository(db));
  app.decorate("deploymentLogRepo", new DeploymentLogRepository(db));
  app.decorate("employeeModelRuleRepo", new EmployeeModelRuleRepository(db));
  app.decorate("principalAccessConfigRepo", new PrincipalAccessConfigRepository(db));
  app.decorate("quotaWindowRepo", new ProviderQuotaWindowRepository(db));
  app.decorate("providerFinanceRepo", new ProviderFinanceRepository(db));
  app.decorate("poolRepo", new ResourcePoolRepository(db));
  app.decorate("featureFlags", featureFlags);
  app.decorate("providerFinanceMode", providerFinanceMode);
  // KEK：从环境注入；F-02 dev fallback 仅测试态可达，生产入口 main.ts 已拦截缺失
  app.decorate(
    "credentialKek",
    decodeKek(
      process.env.CREDENTIAL_KEK ??
        "ZGV2LW9ubHkta2VrLXJlcGxhY2UtaW4tcGlsb3QAAAA=", // dev placeholder 32 bytes
    ),
  );

  app.get("/health", async () => ({ status: "ok", service: "control-api" }));

  // 在插件作用域内注册 cookie/cors/路由，保证 ready 时全部就绪
  void app.register(async (child) => {
    const allowedOrigins = configuredWebOrigins(process.env);
    if (process.env.NODE_ENV === "production" && allowedOrigins.length === 0) {
      throw new Error("生产环境必须配置 WEB_ORIGIN");
    }
    await child.register(cookie, {
      // F-02：dev fallback 仅测试态可达；生产入口 main.ts 已用 requireEnv 拦截缺失
      secret: process.env.COOKIE_SECRET ?? "dev-only-cookie-secret-REPLACE",
    });
    await child.register(cors, {
      origin: allowedOrigins.length > 0 ? allowedOrigins : true,
      credentials: true,
    });
    child.addHook("onRequest", async (req, reply) => {
      if (allowedOrigins.length > 0 && isCrossSiteMutation({
        method: req.method,
        origin: req.headers.origin,
        secFetchSite: req.headers["sec-fetch-site"],
        allowedOrigins,
      })) {
        await reply.code(403).send({ error: "forbidden_origin", message: "禁止跨站写请求" });
      }
    });
    registerAuthRoutes(child);
    registerAdminRoutes(child);
    registerPrincipalRoutes(child, {
      departmentCost: featureFlags.FEATURE_DEPARTMENT_COST,
    });
    registerAuditRoutes(child);
    registerKeyRoutes(child);
    registerGrantRoutes(child);
    registerProviderRoutes(child);
    if (providerFinanceMode !== "OFF") {
      registerProviderFinanceRoutes(child, { mode: providerFinanceMode });
    }
    registerDashboardRoutes(child, {
      usageOverviewV2: featureFlags.FEATURE_USAGE_OVERVIEW_V2,
    });
    registerUsageRoutes(child, {
      overviewV2: featureFlags.FEATURE_USAGE_OVERVIEW_V2,
    });
    registerReadModelRoutes(child);
    registerAdminWriteRoutes(child);
    registerGatewayRequestRoutes(child);
    registerAlertRoutes(child);
    registerRuntimeAssuranceRoutes(child);
    registerOperatingBillRoutes(child);
    registerOperatingBillAccountRoutes(child);
    registerDeploymentLogRoutes(child);
    registerEmployeeModelRuleRoutes(child);
    registerPrincipalAccessConfigRoutes(child);
    registerResourceInsightRoutes(child, {
      utilizationV2: featureFlags.FEATURE_RESOURCE_UTILIZATION_V2,
      procurementReview: featureFlags.FEATURE_PROCUREMENT_REVIEW,
    });
    registerEnterpriseSettingsRoutes(child);
    if (featureFlags.FEATURE_DEPARTMENT_COST) registerDepartmentCostRoutes(child);
    if (featureFlags.FEATURE_DIRECTORY_IMPORT) registerDirectoryRoutes(child);
  });

  return app;
}
