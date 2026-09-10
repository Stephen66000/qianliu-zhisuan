/** Credential probes never enter the business request pipeline. A locked failure generation
 * and credential/config snapshot fence every recovery; probe history survives failed recovery. */
import { createHash } from "node:crypto";
import type { Generated, Kysely, Selectable } from "kysely";
import { parseUpstreamErrorEvidence, sanitizeUpstreamErrorCode, type UpstreamCaller } from "@qianliu/provider-adapters";
type Outcome = Awaited<ReturnType<UpstreamCaller>>;
import type { Database } from "../kysely.js";
import { refreshProbeResourceModels } from "./credential-probe-models.js";

export interface CredentialChatProbeTable {
  id: Generated<string>; enterprise_id: string; provider_resource_id: string; actor_admin_id: string;
  idempotency_key: string; failure_id: string; upstream_model: string; credential_version: number | null;
  credential_digest: string; config_hash: string; status: string; http_status: number | null;
  error_code: string | null; evidence: Record<string, unknown> | null; usage: Record<string, unknown> | null;
  started_at: Generated<Date>; finished_at: Date | null; expires_at: Date; retry_at: Date;
}
type Probe = Selectable<CredentialChatProbeTable>;
export interface CredentialProbeView {
  id: string; status: string; upstreamModel: string; credentialVersion: number | null;
  httpStatus: number | null; errorCode: string | null; evidence: Record<string, unknown> | null;
  startedAt: Date; finishedAt: Date | null; retryAt: Date;
}
export class CredentialProbeConflict extends Error {
  constructor(public readonly code: string) { super(code); }
}
function digest(value: string | null): string {
  return createHash("sha256").update(value ?? "").digest("hex");
}
/** Public history is an explicit projection; never serialize resource ciphertext or its digest. */
export function credentialProbeView(row: Probe): CredentialProbeView {
  const evidence = parseUpstreamErrorEvidence(row.evidence);
  return { id: row.id, status: row.status === "RUNNING" && row.expires_at <= new Date() ? "EXPIRED" : row.status, upstreamModel: row.upstream_model,
    credentialVersion: row.credential_version, httpStatus: row.http_status,
    errorCode: row.error_code, evidence: evidence ? { ...evidence } : null,
    startedAt: row.started_at, finishedAt: row.finished_at, retryAt: row.retry_at };
}

export class CredentialChatProbeRepository {
  constructor(private readonly db: Kysely<Database>) {}

  async list(enterpriseId: string, resourceId: string) {
    const rows = await this.db.selectFrom("credential_chat_probe").selectAll()
      .where("enterprise_id", "=", enterpriseId).where("provider_resource_id", "=", resourceId)
      .orderBy("started_at", "desc").limit(10).execute();
    return rows.map(credentialProbeView);
  }

  async begin(input: { enterpriseId: string; resourceId: string; actorId: string; key: string;
    configHash: (provider: string, mode: string, model: string) => string; now?: Date }) {
    const now = input.now ?? new Date();
    return this.db.transaction().execute(async (trx) => {
      const resource = await trx.selectFrom("provider_resource").selectAll()
        .where("id", "=", input.resourceId).where("enterprise_id", "=", input.enterpriseId)
        .forUpdate().executeTakeFirst();
      if (!resource) throw new CredentialProbeConflict("not_found");
      await trx.updateTable("credential_chat_probe").set({ status: "EXPIRED", finished_at: now })
        .where("provider_resource_id", "=", resource.id).where("status", "=", "RUNNING")
        .where("expires_at", "<=", now).execute();
      const prior = await trx.selectFrom("credential_chat_probe").selectAll()
        .where("provider_resource_id", "=", resource.id).where("idempotency_key", "=", input.key)
        .executeTakeFirst();
      if (prior) return { replay: true as const, probe: prior };
      if (resource.status !== "CREDENTIAL_INVALID") throw new CredentialProbeConflict("not_isolated");
      if (!resource.credential_ciphertext) throw new CredentialProbeConflict("credential_missing");
      if (!resource.auth_failure_id || !resource.auth_failure_model) {
        throw new CredentialProbeConflict("failure_model_unknown");
      }
      const provider = await trx.selectFrom("provider").selectAll().where("id", "=", resource.provider_id)
        .where("enterprise_id", "=", input.enterpriseId).where("status", "=", "ACTIVE").executeTakeFirst();
      if (!provider) throw new CredentialProbeConflict("provider_unavailable");
      const configHash = input.configHash(provider.code, resource.mode, resource.auth_failure_model);
      if (resource.auth_failure_config_hash && resource.auth_failure_config_hash !== configHash) {
        throw new CredentialProbeConflict("configuration_changed");
      }
      const busy = await trx.selectFrom("credential_chat_probe").select("id")
        .where("provider_resource_id", "=", resource.id)
        .where((eb) => eb.or([eb("status", "=", "RUNNING"), eb("retry_at", ">", now)]))
        .executeTakeFirst();
      if (busy) throw new CredentialProbeConflict("probe_cooldown");
      const probe = await trx.insertInto("credential_chat_probe").values({
        enterprise_id: input.enterpriseId, provider_resource_id: resource.id, actor_admin_id: input.actorId,
        idempotency_key: input.key, failure_id: resource.auth_failure_id,
        upstream_model: resource.auth_failure_model, credential_version: resource.credential_version,
        credential_digest: digest(resource.credential_ciphertext), config_hash: configHash,
        status: "RUNNING", http_status: null, error_code: null, evidence: null, usage: null,
        started_at: now, finished_at: null, expires_at: new Date(now.getTime() + 90_000),
        retry_at: new Date(now.getTime() + 300_000),
      }).returningAll().executeTakeFirstOrThrow();
      return { replay: false as const, probe, resource, provider };
    });
  }

  async finish(input: { enterpriseId: string; resourceId: string; probeId: string;
    outcome: Outcome; cancelled: () => boolean;
    configHash: (provider: string, mode: string, model: string) => string; now?: Date }) {
    return this.db.transaction().execute(async (trx) => {
      // Match lock order with begin/failure writers: resource first, then probe.
      const resource = await trx.selectFrom("provider_resource").selectAll()
        .where("id", "=", input.resourceId).where("enterprise_id", "=", input.enterpriseId)
        .forUpdate().executeTakeFirstOrThrow();
      const probe = await trx.selectFrom("credential_chat_probe").selectAll()
        .where("id", "=", input.probeId).where("provider_resource_id", "=", resource.id)
        .forUpdate().executeTakeFirstOrThrow();
      if (probe.status !== "RUNNING") return credentialProbeView(probe);
      const provider = await trx.selectFrom("provider").selectAll()
        .where("id", "=", resource.provider_id).where("enterprise_id", "=", input.enterpriseId)
        .forShare().executeTakeFirstOrThrow();
      const now = input.now ?? new Date();
      const same = resource.status === "CREDENTIAL_INVALID" && provider.status === "ACTIVE"
        && resource.auth_failure_id === probe.failure_id && resource.auth_failure_model === probe.upstream_model
        && resource.credential_version === probe.credential_version
        && digest(resource.credential_ciphertext) === probe.credential_digest
        && input.configHash(provider.code, resource.mode, probe.upstream_model) === probe.config_hash;
      const success = input.outcome.status >= 200 && input.outcome.status < 300
        && input.outcome.committed && !input.outcome.error && !input.outcome.cancelled;
      const status = input.cancelled() ? "CANCELLED" : now >= probe.expires_at ? "EXPIRED"
        : !same ? "STALE" : success ? "RECOVERED" : "FAILED";
      if (status === "RECOVERED") {
        await trx.updateTable("provider_resource").set({ status: "DEGRADED", consecutive_failures: 0,
          cooldown_until: null, credential_refresh_status: "OK", refresh_error_classification: null,
          updated_at: now, version: resource.version + 1,
        }).where("id", "=", resource.id).execute();
        await trx.insertInto("resource_status_event").values({ enterprise_id: input.enterpriseId,
          provider_resource_id: resource.id, from_status: "CREDENTIAL_INVALID", to_status: "DEGRADED",
          reason: "CHAT_AUTH_PROBE_RECOVERED", error_classification: null, actor: "admin",
          consecutive_failures: 0, cooldown_until: null, created_at: now,
        }).execute();
        // Restore derived Key model lists in this transaction, using the existing authorization rules.
        await refreshProbeResourceModels(trx, input.enterpriseId, resource.id, provider.code);
        // Cancellation during the transaction rolls back both recovery and model-list refresh.
        if (input.cancelled()) throw new CredentialProbeConflict("probe_cancelled");
      }
      const evidence = parseUpstreamErrorEvidence(input.outcome.upstreamErrorEvidence);
      const row = await trx.updateTable("credential_chat_probe").set({ status, finished_at: now,
        http_status: input.outcome.status,
        error_code: input.outcome.error ? sanitizeUpstreamErrorCode(input.outcome.error)
          ?? (input.outcome.status >= 400 && input.outcome.status < 600 ? `HTTP_${input.outcome.status}` : "probe_failed") : null,
        evidence: evidence ? { ...evidence } : null,
        usage: { input: input.outcome.usage.input, output: input.outcome.usage.output,
          cache: input.outcome.usage.cache, quality: input.outcome.usage.quality },
        retry_at: new Date(now.getTime() + 300_000),
      }).where("id", "=", probe.id).returningAll().executeTakeFirstOrThrow();
      await trx.insertInto("operation_log").values({ enterprise_id: input.enterpriseId,
        admin_user_id: probe.actor_admin_id, actor_source: "ADMIN", action: "provider_resource.credential_probe",
        target_type: "provider_resource", target_id: resource.id,
        change_summary: { probe_id: probe.id, status, upstream_model: probe.upstream_model,
          credential_version: probe.credential_version, http_status: input.outcome.status },
        result: status === "RECOVERED" ? "SUCCESS" : "FAILURE", failure_reason: status === "RECOVERED" ? null : status,
      }).execute();
      if (status === "RECOVERED" && input.cancelled()) throw new CredentialProbeConflict("probe_cancelled");
      // Key/audit writes may wait on other transactions. Recheck the lease at the commit boundary.
      if (status === "RECOVERED" && Date.now() >= probe.expires_at.getTime()) {
        throw new CredentialProbeConflict("probe_expired");
      }
      return credentialProbeView(row);
    }).catch(async cause => {
      if (!(cause instanceof CredentialProbeConflict)
        || !["probe_cancelled", "probe_expired"].includes(cause.code)) throw cause;
      // Recovery and its success audit were rolled back. Record the actual terminal disposition atomically.
      return this.db.transaction().execute(async trx => {
        const status = cause.code === "probe_cancelled" ? "CANCELLED" : "EXPIRED";
        const row = await trx.updateTable("credential_chat_probe").set({ status, finished_at: new Date(),
          http_status: input.outcome.status,
        }).where("id", "=", input.probeId).where("enterprise_id", "=", input.enterpriseId)
          .where("provider_resource_id", "=", input.resourceId).where("status", "=", "RUNNING")
          .returningAll().executeTakeFirst();
        if (!row) throw cause;
        await trx.insertInto("operation_log").values({ enterprise_id: input.enterpriseId,
          admin_user_id: row.actor_admin_id, actor_source: "ADMIN", action: "provider_resource.credential_probe",
          target_type: "provider_resource", target_id: input.resourceId,
          change_summary: { probe_id: row.id, status, upstream_model: row.upstream_model,
            credential_version: row.credential_version, http_status: input.outcome.status },
          result: "FAILURE", failure_reason: status,
        }).execute();
        return credentialProbeView(row);
      });
    });
  }
}
