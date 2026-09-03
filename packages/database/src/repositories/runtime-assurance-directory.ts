import { sql, type Kysely, type Selectable } from "kysely";
import type { Database } from "../kysely.js";
import { RuntimeAssuranceConflictError, type Person, type PersonExternalIdentity, type PersonView } from "./runtime-assurance-core.js";

export class RuntimeAssuranceDirectoryRepository {
  constructor(protected readonly db: Kysely<Database>) {}

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

}
