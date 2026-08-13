import { randomUUID } from "node:crypto";
import { sql, type Kysely, type Selectable, type Transaction } from "kysely";
import {
  AVAILABILITY_ACTION,
  AVAILABILITY_RULE_TYPE,
  findAvailabilityRuleConflicts,
  matchAvailabilityRule,
  recoverAtForRule,
  scheduleMatches,
  type AvailabilityMatchContext,
  type AvailabilityRuleSnapshot,
  type AvailabilityRuleType,
  type UnifiedAvailabilitySignal,
} from "@qianliu/domain";
import type {
  AvailabilityEventTable,
  AvailabilityRuleTable,
  AvailabilityRuleVersionTable,
  Database,
  NotificationDeliveryTable,
  NotificationEndpointTable,
  DirectoryPersonExternalIdentityTable,
  DirectoryPersonTable,
} from "../kysely.js";

export type Person = Selectable<DirectoryPersonTable>;
export type PersonExternalIdentity = Selectable<DirectoryPersonExternalIdentityTable> & { provider: "WECOM" };
export type AvailabilityRule = Selectable<AvailabilityRuleTable>;
export type AvailabilityRuleVersion = Selectable<AvailabilityRuleVersionTable>;
export type AvailabilityEvent = Selectable<AvailabilityEventTable>;
export type NotificationEndpoint = Selectable<NotificationEndpointTable>;
export type NotificationDelivery = Selectable<NotificationDeliveryTable>;

export class RuntimeAssuranceConflictError extends Error {
  constructor(public readonly code: string, message: string, public readonly details?: unknown) {
    super(message);
    this.name = "RuntimeAssuranceConflictError";
  }
}

export interface PersonView extends Person {
  wecom_identity: PersonExternalIdentity | null;
  active_project_count: number;
}

export interface RuleVersionInput {
  provider_id?: string | null;
  provider_resource_id?: string | null;
  unified_model_id?: string | null;
  upstream_model?: string | null;
  unified_signal?: UnifiedAvailabilitySignal | null;
  action: "WARN_ONLY" | "BLOCK";
  recovery_method?: string | null;
  fallback_duration_seconds?: number | null;
  schedule_timezone?: string | null;
  schedule_days_of_week?: number[] | null;
  schedule_start_time?: string | null;
  schedule_end_time?: string | null;
  priority?: number;
  effective_from?: Date | null;
  effective_to?: Date | null;
}

export interface RuleView {
  rule: AvailabilityRule;
  current_version: AvailabilityRuleVersion;
  versions?: AvailabilityRuleVersion[];
}

export interface SignalInput {
  enterpriseId: string;
  providerId: string;
  providerResourceId: string;
  unifiedModelId: string | null;
  upstreamModel: string;
  signal: UnifiedAvailabilitySignal;
  upstreamCode?: string | null;
  sanitizedSummary?: string | null;
  upstreamRecoverAt?: Date | null;
  aiRequestId: string;
  principalId: string;
  now?: Date;
  mode: "OFF" | "OBSERVE" | "ENFORCE";
  wecomNotify: boolean;
}

export interface SignalResult {
  decision: "ALLOW" | "WARN_ONLY" | "BLOCKED_UPSTREAM";
  event: AvailabilityEvent | null;
  matchedRule: AvailabilityRuleSnapshot | null;
  recoverAt: Date | null;
}

export interface DeliveryContext {
  delivery: NotificationDelivery;
  endpoint: NotificationEndpoint;
  identity: PersonExternalIdentity | null;
  person: Person;
  principal: Selectable<Database["principal"]> | null;
  event: AvailabilityEvent | null;
}

export interface LegacyUnavailableAssessment {
  resource_id: string;
  resource_name: string;
  latest_reason: string | null;
  latest_error_classification: string | null;
  disposition: "SAFE_DOWNGRADE" | "MANUAL_REVIEW";
}

function versionSnapshot(
  row: AvailabilityRuleVersion & { rule_type: AvailabilityRuleType },
): AvailabilityRuleSnapshot {
  return {
    id: row.id,
    ruleId: row.availability_rule_id,
    ruleVersion: row.rule_version,
    ruleType: row.rule_type,
    providerId: row.provider_id,
    providerResourceId: row.provider_resource_id,
    unifiedModelId: row.unified_model_id,
    upstreamModel: row.upstream_model,
    unifiedSignal: row.unified_signal as UnifiedAvailabilitySignal | null,
    action: row.action,
    recoveryMethod: row.recovery_method as AvailabilityRuleSnapshot["recoveryMethod"],
    fallbackDurationSeconds: row.fallback_duration_seconds,
    scheduleTimezone: row.schedule_timezone,
    scheduleDaysOfWeek: row.schedule_days_of_week,
    scheduleStartTime: row.schedule_start_time,
    scheduleEndTime: row.schedule_end_time,
    priority: row.priority,
    effectiveFrom: row.effective_from,
    effectiveTo: row.effective_to,
  };
}

function eventNumber(now: Date): string {
  const day = now.toISOString().slice(0, 10).replaceAll("-", "");
  return `BRK-${day}-${randomUUID().slice(0, 8).toUpperCase()}`;
}

export class RuntimeAssuranceRepository {
  constructor(private readonly db: Kysely<Database>) {}

  async listPeople(): Promise<PersonView[]> {
    const people = await this.db.selectFrom("person").selectAll().orderBy("created_at", "desc").execute();
    const identities = await this.db.selectFrom("person_external_identity").selectAll()
      .where("provider", "=", "WECOM").where("status", "=", "ACTIVE").execute();
    const projectCounts = await this.db.selectFrom("principal")
      .select(["owner_person_id", sql<number>`count(*)::int`.as("count")])
      .where("type", "=", "PROJECT").where("status", "=", "ACTIVE")
      .where("archived_at", "is", null).where("owner_person_id", "is not", null)
      .groupBy("owner_person_id").execute();
    const identityByPerson = new Map(identities.map((item) => [item.person_id, item as PersonExternalIdentity]));
    const countByPerson = new Map(projectCounts.map((item) => [item.owner_person_id!, item.count]));
    return people.map((person) => ({
      ...person,
      wecom_identity: identityByPerson.get(person.id) ?? null,
      active_project_count: countByPerson.get(person.id) ?? 0,
    }));
  }

  async createPerson(input: { name: string; departmentLabel?: string | null }): Promise<Person> {
    return this.db.insertInto("person").values({
      name: input.name,
      department_label: input.departmentLabel ?? null,
    }).returningAll().executeTakeFirstOrThrow();
  }

  async updatePerson(input: {
    id: string;
    expectedVersion: number;
    name?: string;
    departmentLabel?: string | null;
    status?: "ACTIVE" | "DISABLED";
  }): Promise<Person> {
    return this.db.transaction().execute(async (trx) => {
      const person = await trx.selectFrom("person").selectAll().where("id", "=", input.id)
        .forUpdate().executeTakeFirst();
      if (!person) throw new RuntimeAssuranceConflictError("person_not_found", "人员不存在");
      if (person.version !== input.expectedVersion) {
        throw new RuntimeAssuranceConflictError("version_conflict", "人员已被其他操作修改");
      }
      if (input.status === "DISABLED") {
        const owned = await trx.selectFrom("principal").select(sql<number>`count(*)::int`.as("count"))
          .where("type", "=", "PROJECT").where("status", "=", "ACTIVE")
          .where("archived_at", "is", null).where("owner_person_id", "=", input.id)
          .executeTakeFirstOrThrow();
        if (owned.count > 0) {
          throw new RuntimeAssuranceConflictError(
            "person_owns_active_projects",
            `该人员仍负责 ${owned.count} 个启用项目，请先移交负责人`,
            { active_project_count: owned.count },
          );
        }
      }
      const updated = await trx.updateTable("person").set({
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.departmentLabel === undefined ? {} : { department_label: input.departmentLabel }),
        ...(input.status === undefined ? {} : { status: input.status }),
        version: sql`version + 1`,
        updated_at: new Date(),
      }).where("id", "=", input.id).where("version", "=", input.expectedVersion)
        .returningAll().executeTakeFirst();
      if (!updated) throw new RuntimeAssuranceConflictError("version_conflict", "人员已被其他操作修改");
      if (input.status === "DISABLED") {
        await trx.updateTable("person_external_identity").set({ status: "DISABLED", updated_at: new Date() })
          .where("person_id", "=", input.id).where("status", "=", "ACTIVE").execute();
      }
      return updated;
    });
  }

  async setWecomIdentity(input: {
    personId: string;
    expectedPersonVersion: number;
    userId: string;
  }): Promise<PersonExternalIdentity> {
    return this.db.transaction().execute(async (trx) => {
      const person = await trx.selectFrom("person").selectAll().where("id", "=", input.personId)
        .forUpdate().executeTakeFirst();
      if (!person || person.status !== "ACTIVE") {
        throw new RuntimeAssuranceConflictError("person_not_active", "只能给启用人员绑定企微身份");
      }
      if (person.version !== input.expectedPersonVersion) {
        throw new RuntimeAssuranceConflictError("version_conflict", "人员已被其他操作修改");
      }
      const existingOwner = await trx.selectFrom("person_external_identity").selectAll()
        .where("provider", "=", "WECOM").where("provider_user_id", "=", input.userId)
        .where("status", "=", "ACTIVE").executeTakeFirst();
      if (existingOwner && existingOwner.person_id !== input.personId) {
        throw new RuntimeAssuranceConflictError("wecom_userid_in_use", "该企微 userid 已绑定其他人员");
      }
      await trx.updateTable("person_external_identity").set({ status: "DISABLED", updated_at: new Date() })
        .where("person_id", "=", input.personId).where("status", "=", "ACTIVE").execute();
      const identity = await trx.insertInto("person_external_identity").values({
        person_id: input.personId,
        provider: "WECOM",
        provider_user_id: input.userId,
        status: "ACTIVE",
      }).returningAll().executeTakeFirstOrThrow();
      await trx.updateTable("person").set({ version: sql`version + 1`, updated_at: new Date() })
        .where("id", "=", input.personId).execute();
      return identity as PersonExternalIdentity;
    });
  }

  async bindPrincipal(input: {
    principalId: string;
    personId: string;
    relation: "PERSON" | "OWNER";
    expectedVersion: number;
  }): Promise<Selectable<Database["principal"]>> {
    return this.db.transaction().execute(async (trx) => {
      const principal = await trx.selectFrom("principal").selectAll().where("id", "=", input.principalId)
        .forUpdate().executeTakeFirst();
      if (!principal) throw new RuntimeAssuranceConflictError("principal_not_found", "使用主体不存在");
      if (principal.version !== input.expectedVersion) {
        throw new RuntimeAssuranceConflictError("version_conflict", "主体关系已被其他操作修改");
      }
      const expectedType = input.relation === "PERSON" ? "EMPLOYEE" : "PROJECT";
      if (principal.type !== expectedType) {
        throw new RuntimeAssuranceConflictError("principal_relation_mismatch", "人员关系与主体类型不匹配");
      }
      const person = await trx.selectFrom("person").selectAll().where("id", "=", input.personId)
        .where("status", "=", "ACTIVE").executeTakeFirst();
      if (!person) throw new RuntimeAssuranceConflictError("person_not_active", "目标人员不存在或已停用");
      const updated = await trx.updateTable("principal").set({
        ...(input.relation === "PERSON" ? { person_id: input.personId } : { owner_person_id: input.personId }),
        version: sql`version + 1`,
        updated_at: new Date(),
      }).where("id", "=", input.principalId).where("version", "=", input.expectedVersion)
        .returningAll().executeTakeFirst();
      if (!updated) throw new RuntimeAssuranceConflictError("version_conflict", "主体关系已被其他操作修改");
      return updated;
    });
  }

  async listRules(withHistory = false): Promise<RuleView[]> {
    const rules = await this.db.selectFrom("availability_rule").selectAll().orderBy("created_at", "desc").execute();
    const versions = await this.db.selectFrom("availability_rule_version").selectAll()
      .orderBy("rule_version", "desc").execute();
    return rules.map((rule) => {
      const own = versions.filter((version) => version.availability_rule_id === rule.id);
      return { rule, current_version: own[0]!, ...(withHistory ? { versions: own } : {}) };
    });
  }

  async getRule(ruleId: string): Promise<RuleView | null> {
    const rule = await this.db.selectFrom("availability_rule").selectAll().where("id", "=", ruleId).executeTakeFirst();
    if (!rule) return null;
    const versions = await this.db.selectFrom("availability_rule_version").selectAll()
      .where("availability_rule_id", "=", ruleId).orderBy("rule_version", "desc").execute();
    return { rule, current_version: versions[0]!, versions };
  }

  async createRule(input: {
    name: string;
    ruleType: AvailabilityRuleType;
    description?: string | null;
    actorId: string;
    version: RuleVersionInput;
  }): Promise<RuleView> {
    return this.db.transaction().execute(async (trx) => {
      const rule = await trx.insertInto("availability_rule").values({
        name: input.name,
        rule_type: input.ruleType,
        description: input.description ?? null,
        created_by: input.actorId,
      }).returningAll().executeTakeFirstOrThrow();
      const current = await trx.insertInto("availability_rule_version").values({
        availability_rule_id: rule.id,
        rule_version: 1,
        status: "DRAFT",
        ...this.versionValues(input.version),
        created_by: input.actorId,
      }).returningAll().executeTakeFirstOrThrow();
      return { rule, current_version: current, versions: [current] };
    });
  }

  async updateRuleDraft(input: {
    ruleId: string;
    expectedVersion: number;
    actorId: string;
    name?: string;
    description?: string | null;
    version: Partial<RuleVersionInput>;
  }): Promise<RuleView> {
    return this.db.transaction().execute(async (trx) => {
      const rule = await trx.selectFrom("availability_rule").selectAll().where("id", "=", input.ruleId)
        .forUpdate().executeTakeFirst();
      if (!rule) throw new RuntimeAssuranceConflictError("rule_not_found", "规则不存在");
      let current = await trx.selectFrom("availability_rule_version").selectAll()
        .where("availability_rule_id", "=", input.ruleId).orderBy("rule_version", "desc")
        .forUpdate().executeTakeFirstOrThrow();
      if (current.version !== input.expectedVersion) {
        throw new RuntimeAssuranceConflictError("version_conflict", "规则已被其他操作修改");
      }
      if (current.status !== "DRAFT") {
        current = await trx.insertInto("availability_rule_version").values({
          availability_rule_id: rule.id,
          rule_version: current.rule_version + 1,
          status: "DRAFT",
          ...this.copyVersion(current),
          ...this.partialVersionValues(input.version),
          created_by: input.actorId,
          published_by: null,
          published_at: null,
        }).returningAll().executeTakeFirstOrThrow();
      } else {
        const updated = await trx.updateTable("availability_rule_version").set({
          ...this.partialVersionValues(input.version),
          version: sql`version + 1`,
          updated_at: new Date(),
        }).where("id", "=", current.id).where("version", "=", input.expectedVersion)
          .returningAll().executeTakeFirst();
        if (!updated) throw new RuntimeAssuranceConflictError("version_conflict", "规则已被其他操作修改");
        current = updated;
      }
      if (input.name !== undefined || input.description !== undefined) {
        await trx.updateTable("availability_rule").set({
          ...(input.name === undefined ? {} : { name: input.name }),
          ...(input.description === undefined ? {} : { description: input.description }),
          version: sql`version + 1`,
          updated_at: new Date(),
        }).where("id", "=", rule.id).execute();
      }
      const refreshed = await trx.selectFrom("availability_rule").selectAll().where("id", "=", rule.id).executeTakeFirstOrThrow();
      return { rule: refreshed, current_version: current };
    });
  }

  async publishRule(ruleId: string, expectedVersion: number, actorId: string, now = new Date()): Promise<RuleView> {
    return this.db.transaction().execute(async (trx) => {
      const rule = await trx.selectFrom("availability_rule").selectAll().where("id", "=", ruleId)
        .forUpdate().executeTakeFirst();
      if (!rule) throw new RuntimeAssuranceConflictError("rule_not_found", "规则不存在");
      const draft = await trx.selectFrom("availability_rule_version").selectAll()
        .where("availability_rule_id", "=", ruleId).where("status", "=", "DRAFT")
        .orderBy("rule_version", "desc").forUpdate().executeTakeFirst();
      if (!draft) throw new RuntimeAssuranceConflictError("draft_not_found", "没有可发布草稿");
      if (draft.version !== expectedVersion) throw new RuntimeAssuranceConflictError("version_conflict", "规则草稿已变化");
      this.validateRule(rule, draft);
      const published = await this.publishedSnapshots(trx);
      const candidate = versionSnapshot({ ...draft, rule_type: rule.rule_type });
      const conflicts = findAvailabilityRuleConflicts(candidate, published);
      if (conflicts.length > 0) {
        throw new RuntimeAssuranceConflictError("rule_conflict", "存在相同作用域和生效期的已发布规则", {
          rule_ids: conflicts.map((item) => item.ruleId),
        });
      }
      await trx.updateTable("availability_rule_version").set({ status: "SUPERSEDED", effective_to: now, updated_at: now })
        .where("availability_rule_id", "=", ruleId).where("status", "=", "PUBLISHED").execute();
      const current = await trx.updateTable("availability_rule_version").set({
        status: "PUBLISHED",
        effective_from: draft.effective_from ?? now,
        published_by: actorId,
        published_at: now,
        version: sql`version + 1`,
        updated_at: now,
      }).where("id", "=", draft.id).returningAll().executeTakeFirstOrThrow();
      return { rule, current_version: current };
    });
  }

  async disableRule(ruleId: string, expectedVersion: number, actorId: string, now = new Date()): Promise<RuleView> {
    return this.db.transaction().execute(async (trx) => {
      const rule = await trx.selectFrom("availability_rule").selectAll().where("id", "=", ruleId)
        .forUpdate().executeTakeFirstOrThrow();
      const current = await trx.selectFrom("availability_rule_version").selectAll()
        .where("availability_rule_id", "=", ruleId).orderBy("rule_version", "desc")
        .forUpdate().executeTakeFirstOrThrow();
      if (current.version !== expectedVersion) throw new RuntimeAssuranceConflictError("version_conflict", "规则已变化");
      if (current.status === "PUBLISHED") {
        await trx.updateTable("availability_rule_version").set({ status: "SUPERSEDED", effective_to: now, updated_at: now })
          .where("id", "=", current.id).execute();
      }
      const disabled = await trx.insertInto("availability_rule_version").values({
        availability_rule_id: ruleId,
        rule_version: current.rule_version + 1,
        status: "DISABLED",
        ...this.copyVersion(current),
        effective_from: now,
        created_by: actorId,
      }).returningAll().executeTakeFirstOrThrow();
      return { rule, current_version: disabled };
    });
  }

  async rollbackRule(ruleId: string, sourceVersion: number, expectedVersion: number, actorId: string, now = new Date()): Promise<RuleView> {
    return this.db.transaction().execute(async (trx) => {
      const rule = await trx.selectFrom("availability_rule").selectAll().where("id", "=", ruleId)
        .forUpdate().executeTakeFirstOrThrow();
      const latest = await trx.selectFrom("availability_rule_version").selectAll()
        .where("availability_rule_id", "=", ruleId).orderBy("rule_version", "desc")
        .forUpdate().executeTakeFirstOrThrow();
      if (latest.version !== expectedVersion) throw new RuntimeAssuranceConflictError("version_conflict", "规则已变化");
      const source = await trx.selectFrom("availability_rule_version").selectAll()
        .where("availability_rule_id", "=", ruleId).where("rule_version", "=", sourceVersion).executeTakeFirst();
      if (!source) throw new RuntimeAssuranceConflictError("source_version_not_found", "回滚源版本不存在");
      await trx.updateTable("availability_rule_version").set({ status: "SUPERSEDED", effective_to: now, updated_at: now })
        .where("availability_rule_id", "=", ruleId).where("status", "=", "PUBLISHED").execute();
      const restored = await trx.insertInto("availability_rule_version").values({
        availability_rule_id: ruleId,
        rule_version: latest.rule_version + 1,
        status: "PUBLISHED",
        ...this.copyVersion(source),
        effective_from: now,
        effective_to: null,
        created_by: actorId,
        published_by: actorId,
        published_at: now,
      }).returningAll().executeTakeFirstOrThrow();
      return { rule, current_version: restored };
    });
  }

  async activeRuleSnapshots(now = new Date()): Promise<AvailabilityRuleSnapshot[]> {
    const rows = await this.db.selectFrom("availability_rule_version")
      .innerJoin("availability_rule", "availability_rule.id", "availability_rule_version.availability_rule_id")
      .selectAll("availability_rule_version").select("availability_rule.rule_type")
      .where("availability_rule_version.status", "=", "PUBLISHED")
      .where((eb) => eb.or([eb("effective_from", "is", null), eb("effective_from", "<=", now)]))
      .where((eb) => eb.or([eb("effective_to", "is", null), eb("effective_to", ">", now)]))
      .execute();
    return rows.map(versionSnapshot);
  }

  async evaluateSchedule(context: AvailabilityMatchContext): Promise<AvailabilityRuleSnapshot | null> {
    return matchAvailabilityRule(await this.activeRuleSnapshots(context.now), context, AVAILABILITY_RULE_TYPE.SCHEDULE_BLOCK);
  }

  async recordSignal(input: SignalInput): Promise<SignalResult> {
    const now = input.now ?? new Date();
    if (input.mode === "OFF") return { decision: "ALLOW", event: null, matchedRule: null, recoverAt: null };
    const rules = await this.activeRuleSnapshots(now);
    const matched = matchAvailabilityRule(rules, {
      now,
      providerId: input.providerId,
      providerResourceId: input.providerResourceId,
      unifiedModelId: input.unifiedModelId,
      upstreamModel: input.upstreamModel,
      unifiedSignal: input.signal,
    }, input.signal === "TECHNICAL_FAILURE" || input.signal === "CONFIGURATION_ERROR"
      ? AVAILABILITY_RULE_TYPE.OBSERVATION_ALERT
      : AVAILABILITY_RULE_TYPE.UPSTREAM_SIGNAL);
    if (!matched || matched.action === AVAILABILITY_ACTION.WARN_ONLY || input.mode === "OBSERVE") {
      await this.upsertObservationAlert(input, matched, now);
      return { decision: matched ? "WARN_ONLY" : "ALLOW", event: null, matchedRule: matched, recoverAt: null };
    }
    const recoverAt = recoverAtForRule(matched, now, input.upstreamRecoverAt);
    if (!recoverAt && matched.recoveryMethod !== "MANUAL") {
      await this.upsertObservationAlert(input, matched, now, "缺少可靠恢复字段，已降为预警");
      return { decision: "WARN_ONLY", event: null, matchedRule: matched, recoverAt: null };
    }
    const dedupKey = [matched.id, input.providerResourceId, input.upstreamModel, input.signal, recoverAt?.toISOString() ?? "manual"].join(":");
    const event = await this.db.transaction().execute(async (trx) => {
      await sql`SELECT pg_advisory_xact_lock(hashtext(${dedupKey}))`.execute(trx);
      const existing = await trx.selectFrom("availability_event").selectAll()
        .where("dedup_key", "=", dedupKey).where("status", "=", "OPEN").forUpdate().executeTakeFirst();
      if (existing) {
        let updated = await trx.updateTable("availability_event").set({
          affected_request_count: sql`affected_request_count + 1`, updated_at: now,
          ...(input.upstreamRecoverAt && (!existing.recover_at || input.upstreamRecoverAt > existing.recover_at)
            ? { recover_at: input.upstreamRecoverAt }
            : {}),
        }).where("id", "=", existing.id).returningAll().executeTakeFirstOrThrow();
        if (input.wecomNotify && await this.enqueueEventDeliveryTx(trx, updated, input.principalId, "TRIGGER")) {
          updated = await trx.updateTable("availability_event").set({
            affected_person_count: sql`affected_person_count + 1`, updated_at: now,
          }).where("id", "=", existing.id).returningAll().executeTakeFirstOrThrow();
        }
        return updated;
      }
      const created = await trx.insertInto("availability_event").values({
        event_number: eventNumber(now),
        availability_rule_id: matched.ruleId,
        rule_version_id: matched.id,
        rule_version: matched.ruleVersion,
        provider_id: input.providerId,
        provider_resource_id: input.providerResourceId,
        unified_model_id: input.unifiedModelId,
        upstream_model: input.upstreamModel,
        unified_signal: input.signal,
        upstream_code: input.upstreamCode ?? null,
        sanitized_summary: input.sanitizedSummary?.slice(0, 255) ?? null,
        availability_decision: "BLOCKED_UPSTREAM",
        trigger_ai_request_id: input.aiRequestId,
        trigger_principal_id: input.principalId,
        recovery_method: matched.recoveryMethod!,
        dedup_key: dedupKey,
        recover_at: recoverAt,
        affected_request_count: 1,
      }).returningAll().executeTakeFirstOrThrow();
      if (input.wecomNotify && await this.enqueueEventDeliveryTx(trx, created, input.principalId, "TRIGGER")) {
        return trx.updateTable("availability_event").set({ affected_person_count: 1 })
          .where("id", "=", created.id).returningAll().executeTakeFirstOrThrow();
      }
      return created;
    });
    return { decision: "BLOCKED_UPSTREAM", event, matchedRule: matched, recoverAt };
  }

  async createScheduleEvent(input: {
    rule: AvailabilityRuleSnapshot;
    enterpriseId: string;
    providerId: string;
    providerResourceId: string;
    unifiedModelId: string | null;
    upstreamModel: string;
    aiRequestId: string;
    principalId: string;
    now: Date;
    wecomNotify: boolean;
  }): Promise<AvailabilityEvent> {
    const dedupKey = `${input.rule.id}:${input.providerResourceId}:${input.upstreamModel}:schedule`;
    return this.db.transaction().execute(async (trx) => {
      await sql`SELECT pg_advisory_xact_lock(hashtext(${dedupKey}))`.execute(trx);
      const existing = await trx.selectFrom("availability_event").selectAll()
        .where("dedup_key", "=", dedupKey).where("status", "=", "OPEN").forUpdate().executeTakeFirst();
      if (existing) {
        if (input.wecomNotify && await this.enqueueEventDeliveryTx(trx, existing, input.principalId, "TRIGGER")) {
          return trx.updateTable("availability_event").set({
            affected_person_count: sql`affected_person_count + 1`, updated_at: input.now,
          }).where("id", "=", existing.id).returningAll().executeTakeFirstOrThrow();
        }
        return existing;
      }
      const created = await trx.insertInto("availability_event").values({
        event_number: eventNumber(input.now), availability_rule_id: input.rule.ruleId,
        rule_version_id: input.rule.id, rule_version: input.rule.ruleVersion,
        provider_id: input.providerId, provider_resource_id: input.providerResourceId,
        unified_model_id: input.unifiedModelId, upstream_model: input.upstreamModel,
        unified_signal: "UPSTREAM_MAINTENANCE", availability_decision: "BLOCKED_SCHEDULE",
        trigger_ai_request_id: input.aiRequestId, trigger_principal_id: input.principalId,
        recovery_method: "SCHEDULE_END", dedup_key: dedupKey, affected_request_count: 1,
      }).returningAll().executeTakeFirstOrThrow();
      if (input.wecomNotify && await this.enqueueEventDeliveryTx(trx, created, input.principalId, "TRIGGER")) {
        return trx.updateTable("availability_event").set({ affected_person_count: 1 })
          .where("id", "=", created.id).returningAll().executeTakeFirstOrThrow();
      }
      return created;
    });
  }

  async listEvents(history = false): Promise<AvailabilityEvent[]> {
    let query = this.db.selectFrom("availability_event").selectAll();
    if (!history) query = query.where("status", "=", "OPEN");
    return query.orderBy("started_at", "desc").execute();
  }

  async findOpenBlock(providerResourceId: string, upstreamModel?: string | null): Promise<AvailabilityEvent | null> {
    let query = this.db.selectFrom("availability_event").selectAll()
      .where("provider_resource_id", "=", providerResourceId).where("status", "=", "OPEN");
    if (upstreamModel) {
      query = query.where((eb) => eb.or([eb("upstream_model", "=", upstreamModel), eb("upstream_model", "is", null)]));
    }
    return await query.orderBy("started_at", "desc").executeTakeFirst() ?? null;
  }

  async recoverEvent(eventId: string, reason: string, manual = true, notify = true, now = new Date()): Promise<AvailabilityEvent> {
    return this.db.transaction().execute(async (trx) => {
      const event = await trx.selectFrom("availability_event").selectAll().where("id", "=", eventId)
        .forUpdate().executeTakeFirst();
      if (!event) throw new RuntimeAssuranceConflictError("event_not_found", "熔断事件不存在");
      if (event.status !== "OPEN") return event;
      const recovered = await trx.updateTable("availability_event").set({
        status: manual ? "MANUALLY_RECOVERED" : "RECOVERED",
        recovered_at: now,
        recovery_reason: reason.slice(0, 255),
        updated_at: now,
      }).where("id", "=", eventId).returningAll().executeTakeFirstOrThrow();
      if (notify) {
        const recipients = await trx.selectFrom("notification_delivery")
          .select("recipient_person_id").distinct()
          .where("availability_event_id", "=", event.id)
          .where("delivery_type", "=", "TRIGGER").execute();
        if (recipients.length > 0) {
          for (const recipient of recipients) {
            await this.enqueuePersonDeliveryTx(trx, recovered, recipient.recipient_person_id, "RECOVERY");
          }
        } else if (event.trigger_principal_id) {
          await this.enqueueEventDeliveryTx(trx, recovered, event.trigger_principal_id, "RECOVERY");
        }
      }
      return recovered;
    });
  }

  async recoverDueEvents(now = new Date(), notify = true): Promise<AvailabilityEvent[]> {
    const due = await this.db.selectFrom("availability_event").selectAll()
      .where("status", "=", "OPEN").where("recover_at", "is not", null).where("recover_at", "<=", now).execute();
    const recovered: AvailabilityEvent[] = [];
    for (const event of due) recovered.push(await this.recoverEvent(event.id, "到达规则恢复时间", false, notify, now));
    return recovered;
  }

  async recoverInactiveScheduleEvents(now = new Date(), notify = true): Promise<AvailabilityEvent[]> {
    const rows = await this.db.selectFrom("availability_event")
      .innerJoin("availability_rule_version", "availability_rule_version.id", "availability_event.rule_version_id")
      .innerJoin("availability_rule", "availability_rule.id", "availability_rule_version.availability_rule_id")
      .select(["availability_event.id as event_id", "availability_event.rule_version_id", "availability_rule.rule_type"])
      .where("availability_event.status", "=", "OPEN")
      .where("availability_event.availability_decision", "=", "BLOCKED_SCHEDULE")
      .execute();
    const recovered: AvailabilityEvent[] = [];
    for (const row of rows) {
      const version = await this.db.selectFrom("availability_rule_version").selectAll()
        .where("id", "=", row.rule_version_id).executeTakeFirstOrThrow();
      const snapshot = versionSnapshot({ ...version, rule_type: row.rule_type as AvailabilityRuleType });
      if (!scheduleMatches(snapshot, now)) {
        recovered.push(await this.recoverEvent(row.event_id, "计划熔断时段已结束", false, notify, now));
      }
    }
    return recovered;
  }

  /**
   * 旧 UNAVAILABLE 只读 Shadow 盘点。只有最近一次明确属于技术故障的旧状态事件
   * 才能自动降为 DEGRADED；其余全部保留并要求人工核验，绝不推断为新硬熔断。
   */
  async assessLegacyUnavailable(): Promise<LegacyUnavailableAssessment[]> {
    const rows = await this.db.selectFrom("provider_resource")
      .leftJoin("resource_status_event", (join) => join
        .onRef("resource_status_event.provider_resource_id", "=", "provider_resource.id")
        .on("resource_status_event.id", "=", sql<string>`(
          select e.id from resource_status_event e
          where e.provider_resource_id = provider_resource.id
          order by e.created_at desc, e.id desc limit 1
        )`))
      .select([
        "provider_resource.id as resource_id", "provider_resource.name as resource_name",
        "resource_status_event.reason as latest_reason",
        "resource_status_event.error_classification as latest_error_classification",
      ])
      .where("provider_resource.status", "=", "UNAVAILABLE")
      .execute();
    const technicalReasons = new Set(["FAILURE_THRESHOLD", "RATE_LIMITED", "PASSIVE_FAILURE"]);
    const technicalClassifications = new Set(["UPSTREAM_TEMPORARY", "TRANSPORT_ERROR", "UPSTREAM_RATE_LIMITED", "UNKNOWN"]);
    return rows.map((row) => ({
      ...row,
      disposition: technicalReasons.has(row.latest_reason ?? "") ||
        technicalClassifications.has(row.latest_error_classification ?? "")
        ? "SAFE_DOWNGRADE" as const
        : "MANUAL_REVIEW" as const,
    }));
  }

  /** W05B：只执行 Shadow 已证明安全的技术性 UNAVAILABLE -> DEGRADED。 */
  async migrateSafeLegacyUnavailable(now = new Date()): Promise<LegacyUnavailableAssessment[]> {
    const safe = (await this.assessLegacyUnavailable()).filter((item) => item.disposition === "SAFE_DOWNGRADE");
    for (const item of safe) {
      await this.db.transaction().execute(async (trx) => {
        const resource = await trx.selectFrom("provider_resource").selectAll()
          .where("id", "=", item.resource_id).where("status", "=", "UNAVAILABLE")
          .forUpdate().executeTakeFirst();
        if (!resource) return;
        await trx.updateTable("provider_resource").set({
          status: "DEGRADED", cooldown_until: null, version: sql`version + 1`, updated_at: now,
        }).where("id", "=", resource.id).execute();
        await trx.insertInto("resource_status_event").values({
          enterprise_id: resource.enterprise_id,
          provider_resource_id: resource.id,
          from_status: "UNAVAILABLE",
          to_status: "DEGRADED",
          reason: "RA_LEGACY_TECHNICAL_DOWNGRADE",
          error_classification: item.latest_error_classification,
          consecutive_failures: resource.consecutive_failures,
          cooldown_until: null,
          actor: "system",
        }).execute();
      });
    }
    return safe;
  }

  async getOverview(): Promise<Record<string, unknown>> {
    const resourceRows = await this.db.selectFrom("provider_resource")
      .select(["status", sql<number>`count(*)::int`.as("count")]).groupBy("status").execute();
    const open = await this.db.selectFrom("availability_event").select([
      sql<number>`count(*)::int`.as("count"),
      sql<number>`count(distinct provider_resource_id)::int`.as("resource_count"),
      sql<number>`coalesce(sum(affected_request_count), 0)::int`.as("affected_requests"),
      sql<Date | null>`min(recover_at)`.as("next_recover_at"),
    ]).where("status", "=", "OPEN").executeTakeFirstOrThrow();
    return {
      resources: Object.fromEntries(resourceRows.map((row) => [row.status, row.count])),
      open_event_count: open.count,
      blocked_resource_count: open.resource_count,
      affected_request_count: open.affected_requests,
      next_recover_at: open.next_recover_at,
    };
  }

  async getEndpoint(): Promise<NotificationEndpoint | null> {
    return await this.db.selectFrom("notification_endpoint").selectAll().orderBy("created_at", "desc").executeTakeFirst() ?? null;
  }

  async saveEndpoint(input: {
    corpId: string;
    agentId: string;
    secretCiphertext: string;
    secretFingerprint: string;
    status: "ACTIVE" | "DISABLED";
    expectedVersion?: number;
  }): Promise<NotificationEndpoint> {
    return this.db.transaction().execute(async (trx) => {
      const current = await trx.selectFrom("notification_endpoint").selectAll().orderBy("created_at", "desc")
        .forUpdate().executeTakeFirst();
      if (!current) {
        return trx.insertInto("notification_endpoint").values({
          provider: "WECOM_APP", corp_id: input.corpId, agent_id: input.agentId,
          secret_ciphertext: input.secretCiphertext, secret_fingerprint: input.secretFingerprint,
          status: input.status,
        }).returningAll().executeTakeFirstOrThrow();
      }
      if (input.expectedVersion !== current.version) {
        throw new RuntimeAssuranceConflictError("version_conflict", "企微应用配置已被其他操作修改");
      }
      return trx.updateTable("notification_endpoint").set({
        corp_id: input.corpId, agent_id: input.agentId,
        secret_ciphertext: input.secretCiphertext, secret_fingerprint: input.secretFingerprint,
        status: input.status, version: sql`version + 1`, updated_at: new Date(),
      }).where("id", "=", current.id).where("version", "=", input.expectedVersion!)
        .returningAll().executeTakeFirstOrThrow();
    });
  }

  async enqueueTestDelivery(personId: string): Promise<NotificationDelivery> {
    return this.db.transaction().execute(async (trx) => {
      const endpoint = await trx.selectFrom("notification_endpoint").selectAll().where("status", "=", "ACTIVE").executeTakeFirst();
      if (!endpoint) throw new RuntimeAssuranceConflictError("wecom_endpoint_inactive", "企微应用未启用");
      const identity = await trx.selectFrom("person_external_identity").selectAll()
        .where("person_id", "=", personId).where("provider", "=", "WECOM").where("status", "=", "ACTIVE").executeTakeFirst();
      if (!identity) throw new RuntimeAssuranceConflictError("wecom_identity_missing", "该人员未配置企微 userid");
      return trx.insertInto("notification_delivery").values({
        notification_endpoint_id: endpoint.id, recipient_person_id: personId,
        recipient_identity_id: identity.id, delivery_type: "TEST",
        idempotency_key: `test:${personId}:${randomUUID()}`,
      }).returningAll().executeTakeFirstOrThrow();
    });
  }

  async listDeliveries(limit = 100): Promise<NotificationDelivery[]> {
    return this.db.selectFrom("notification_delivery").selectAll().orderBy("created_at", "desc").limit(limit).execute();
  }

  async getDeliveryContext(deliveryId: string): Promise<DeliveryContext | null> {
    const delivery = await this.db.selectFrom("notification_delivery").selectAll()
      .where("id", "=", deliveryId).executeTakeFirst();
    if (!delivery) return null;
    const [endpoint, identity, person, event] = await Promise.all([
      this.db.selectFrom("notification_endpoint").selectAll()
        .where("id", "=", delivery.notification_endpoint_id).executeTakeFirst(),
      delivery.recipient_identity_id
        ? this.db.selectFrom("person_external_identity").selectAll()
          .where("id", "=", delivery.recipient_identity_id).where("provider", "=", "WECOM").executeTakeFirst()
        : Promise.resolve(undefined),
      this.db.selectFrom("person").selectAll().where("id", "=", delivery.recipient_person_id).executeTakeFirst(),
      delivery.availability_event_id
        ? this.db.selectFrom("availability_event").selectAll()
          .where("id", "=", delivery.availability_event_id).executeTakeFirst()
        : Promise.resolve(undefined),
    ]);
    if (!endpoint || !person) return null;
    const principal = event?.trigger_principal_id
      ? await this.db.selectFrom("principal").selectAll().where("id", "=", event.trigger_principal_id).executeTakeFirst()
      : undefined;
    return { delivery, endpoint, identity: identity as PersonExternalIdentity | undefined ?? null, person, principal: principal ?? null, event: event ?? null };
  }

  async releaseStaleDeliveries(staleBefore: Date, now = new Date()): Promise<number> {
    const result = await this.db.updateTable("notification_delivery").set({
      status: "RETRYABLE_FAILED", next_attempt_at: now,
      last_error_classification: "STALE_CLAIM_RECOVERED", updated_at: now,
    }).where("status", "=", "IN_PROGRESS").where("updated_at", "<", staleBefore).executeTakeFirst();
    return Number(result.numUpdatedRows ?? 0n);
  }

  async claimDeliveries(limit = 20, now = new Date()): Promise<NotificationDelivery[]> {
    return this.db.transaction().execute(async (trx) => {
      const rows = await trx.selectFrom("notification_delivery").selectAll()
        .where("status", "in", ["PENDING", "RETRYABLE_FAILED"])
        .where((eb) => eb.or([eb("next_attempt_at", "is", null), eb("next_attempt_at", "<=", now)]))
        .orderBy("created_at", "asc").limit(limit).forUpdate().skipLocked().execute();
      if (rows.length === 0) return [];
      await trx.updateTable("notification_delivery").set({ status: "IN_PROGRESS", updated_at: now })
        .where("id", "in", rows.map((row) => row.id)).execute();
      return rows.map((row) => ({ ...row, status: "IN_PROGRESS" as const }));
    });
  }

  async completeDelivery(input: {
    id: string;
    status: "SENT" | "RETRYABLE_FAILED" | "PERMANENT_FAILED" | "SKIPPED";
    providerMessageId?: string | null;
    providerErrorCode?: string | null;
    classification?: string | null;
    nextAttemptAt?: Date | null;
  }): Promise<void> {
    await this.db.updateTable("notification_delivery").set({
      status: input.status,
      attempt_count: sql`attempt_count + 1`,
      provider_message_id: input.providerMessageId ?? null,
      provider_error_code: input.providerErrorCode ?? null,
      last_error_classification: input.classification ?? null,
      next_attempt_at: input.nextAttemptAt ?? null,
      sent_at: input.status === "SENT" ? new Date() : null,
      updated_at: new Date(),
    }).where("id", "=", input.id).execute();
  }

  private versionValues(input: RuleVersionInput) {
    return {
      provider_id: input.provider_id ?? null,
      provider_resource_id: input.provider_resource_id ?? null,
      unified_model_id: input.unified_model_id ?? null,
      upstream_model: input.upstream_model ?? null,
      unified_signal: input.unified_signal ?? null,
      action: input.action,
      recovery_method: input.recovery_method ?? null,
      fallback_duration_seconds: input.fallback_duration_seconds ?? null,
      schedule_timezone: input.schedule_timezone ?? null,
      schedule_days_of_week: input.schedule_days_of_week ?? null,
      schedule_start_time: input.schedule_start_time ?? null,
      schedule_end_time: input.schedule_end_time ?? null,
      priority: input.priority ?? 100,
      effective_from: input.effective_from ?? null,
      effective_to: input.effective_to ?? null,
    };
  }

  private partialVersionValues(input: Partial<RuleVersionInput>) {
    const values: Record<string, unknown> = {};
    const mapping: Array<[keyof RuleVersionInput, string]> = [
      ["provider_id", "provider_id"], ["provider_resource_id", "provider_resource_id"],
      ["unified_model_id", "unified_model_id"], ["upstream_model", "upstream_model"],
      ["unified_signal", "unified_signal"], ["action", "action"],
      ["recovery_method", "recovery_method"], ["fallback_duration_seconds", "fallback_duration_seconds"],
      ["schedule_timezone", "schedule_timezone"], ["schedule_days_of_week", "schedule_days_of_week"],
      ["schedule_start_time", "schedule_start_time"], ["schedule_end_time", "schedule_end_time"],
      ["priority", "priority"], ["effective_from", "effective_from"], ["effective_to", "effective_to"],
    ];
    for (const [from, to] of mapping) if (input[from] !== undefined) values[to] = input[from];
    return values;
  }

  private copyVersion(row: AvailabilityRuleVersion) {
    return {
      provider_id: row.provider_id, provider_resource_id: row.provider_resource_id,
      unified_model_id: row.unified_model_id, upstream_model: row.upstream_model,
      unified_signal: row.unified_signal, action: row.action, recovery_method: row.recovery_method,
      fallback_duration_seconds: row.fallback_duration_seconds, schedule_timezone: row.schedule_timezone,
      schedule_days_of_week: row.schedule_days_of_week, schedule_start_time: row.schedule_start_time,
      schedule_end_time: row.schedule_end_time, priority: row.priority,
      effective_from: row.effective_from, effective_to: row.effective_to,
    };
  }

  private validateRule(rule: AvailabilityRule, version: AvailabilityRuleVersion): void {
    if (version.action === "BLOCK" && !version.recovery_method) {
      throw new RuntimeAssuranceConflictError("recovery_required", "硬熔断规则必须配置恢复方式");
    }
    if (rule.rule_type === "UPSTREAM_SIGNAL" && !version.unified_signal) {
      throw new RuntimeAssuranceConflictError("signal_required", "上游信号规则必须选择统一信号");
    }
    if (rule.rule_type === "SCHEDULE_BLOCK" &&
      (!version.schedule_timezone || !version.schedule_start_time || !version.schedule_end_time)) {
      throw new RuntimeAssuranceConflictError("schedule_required", "计划熔断必须配置时区和时间窗");
    }
  }

  private async publishedSnapshots(trx: Transaction<Database>): Promise<AvailabilityRuleSnapshot[]> {
    const rows = await trx.selectFrom("availability_rule_version")
      .innerJoin("availability_rule", "availability_rule.id", "availability_rule_version.availability_rule_id")
      .selectAll("availability_rule_version").select("availability_rule.rule_type")
      .where("availability_rule_version.status", "=", "PUBLISHED").execute();
    return rows.map(versionSnapshot);
  }

  private async upsertObservationAlert(
    input: SignalInput,
    matched: AvailabilityRuleSnapshot | null,
    now: Date,
    detail?: string,
  ): Promise<void> {
    const alertKey = `RUNTIME_ASSURANCE:${input.signal}:${input.providerResourceId}`;
    await sql`
      INSERT INTO alert_event (
        enterprise_id, alert_key, domain, signal, severity, title, detail,
        resource_id, principal_id, ai_request_id, status, first_seen_at, last_seen_at
      ) VALUES (
        ${input.enterpriseId}, ${alertKey}, 'RESOURCE_UNAVAILABLE', ${input.signal},
        'MEDIUM', '运行保障预警', ${detail ?? input.sanitizedSummary ?? matched?.ruleType ?? null},
        ${input.providerResourceId}, ${input.principalId}, ${input.aiRequestId}, 'OPEN', ${now}, ${now}
      )
      ON CONFLICT (enterprise_id, alert_key) WHERE status = 'OPEN'
      DO UPDATE SET last_seen_at = EXCLUDED.last_seen_at, ai_request_id = EXCLUDED.ai_request_id,
                    detail = EXCLUDED.detail
    `.execute(this.db);
  }

  private async enqueueEventDeliveryTx(
    trx: Transaction<Database>,
    event: AvailabilityEvent,
    principalId: string,
    type: "TRIGGER" | "RECOVERY",
  ): Promise<boolean> {
    const principal = await trx.selectFrom("principal").select(["type", "person_id", "owner_person_id"])
      .where("id", "=", principalId).executeTakeFirst();
    const personId = principal?.type === "EMPLOYEE" ? principal.person_id : principal?.owner_person_id;
    if (!personId) return false;
    return this.enqueuePersonDeliveryTx(trx, event, personId, type);
  }

  private async enqueuePersonDeliveryTx(
    trx: Transaction<Database>,
    event: AvailabilityEvent,
    personId: string,
    type: "TRIGGER" | "RECOVERY",
  ): Promise<boolean> {
    const endpoint = await trx.selectFrom("notification_endpoint").selectAll().where("status", "=", "ACTIVE").executeTakeFirst();
    if (!endpoint) return false;
    const identity = await trx.selectFrom("person_external_identity").selectAll()
      .where("person_id", "=", personId).where("provider", "=", "WECOM").where("status", "=", "ACTIVE").executeTakeFirst();
    const inserted = await trx.insertInto("notification_delivery").values({
      availability_event_id: event.id, notification_endpoint_id: endpoint.id,
      recipient_person_id: personId, recipient_identity_id: identity?.id ?? null,
      delivery_type: type, idempotency_key: `${event.id}:${personId}:${type}`,
      status: identity ? "PENDING" : "SKIPPED",
      last_error_classification: identity ? null : "RECIPIENT_IDENTITY_MISSING",
    }).onConflict((oc) => oc.column("idempotency_key").doNothing()).returning("id").executeTakeFirst();
    return Boolean(inserted);
  }
}
