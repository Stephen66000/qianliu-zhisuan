import { sql, type Transaction } from "kysely";
import {
  AVAILABILITY_RULE_TYPE, findAvailabilityRuleConflicts, matchAvailabilityRule,
  type AvailabilityMatchContext, type AvailabilityRuleSnapshot, type AvailabilityRuleType,
} from "@qianliu/domain";
import type { Database } from "../kysely.js";
import {
  RuntimeAssuranceConflictError, versionSnapshot, type AvailabilityRule,
  type AvailabilityRuleVersion, type RuleVersionInput, type RuleView,
} from "./runtime-assurance-core.js";
import { RuntimeAssuranceDirectoryRepository } from "./runtime-assurance-directory.js";

export class RuntimeAssuranceRulesRepository extends RuntimeAssuranceDirectoryRepository {
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

}
