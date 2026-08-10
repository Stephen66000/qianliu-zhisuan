import type { Kysely } from "kysely";
import type { Database } from "@qianliu/database";

import {
  hasCurrentInvocationAuthorization,
  listCurrentAuthorizedModels,
} from "../auth/current-model-authorization.js";

export interface InvocationIdentity {
  enterpriseId: string;
  principalId: string;
  keyId: string;
}

export interface InvocationCandidate {
  routeId?: string;
  resourceId: string;
  providerCode: string;
  upstreamModel: string;
  modelAlias: string;
}

export interface AdmissibleModel {
  id: string;
  alias: string;
  display_name: string;
}

/**
 * POOL-040 兼容入口。准入事实统一委托给 current-model-authorization，避免模型目录、
 * 最终 Route 栅栏和 POOL-043 计费规则冻结形成两套口径。
 */
export async function listCurrentInvocableModels(
  db: Kysely<Database>,
  identity: InvocationIdentity,
): Promise<AdmissibleModel[]> {
  return listCurrentAuthorizedModels(db, { ...identity, now: new Date() });
}

export async function hasCurrentInvocationAdmission(
  db: Kysely<Database>,
  identity: InvocationIdentity,
  candidate: InvocationCandidate,
): Promise<boolean> {
  return hasCurrentInvocationAuthorization(db, {
    ...identity,
    ...candidate,
    now: new Date(),
  });
}
