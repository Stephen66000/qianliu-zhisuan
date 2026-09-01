/**
 * Principal Grant 仓储 —— 主体授权与额度（W03）。
 *
 * 依据：TRD §5.5。一期 quota_unit 固定 TOKEN。
 * 创建 grant 时同步初始化 quota_counter（W14 热路径消费；M1 建表+初始化）。
 */
import { sql, type Kysely, type Selectable } from "kysely";
import type { Database, PrincipalGrantTable } from "../kysely.js";
import { PrincipalNotActiveError } from "./principal-repository.js";

export type PrincipalGrant = Selectable<PrincipalGrantTable>;

export interface CreateGrantInput {
  enterprise_id: string;
  principal_id: string;
  provider: string;
  model_alias: string;
  quota_value: bigint;
  allow_overage?: boolean;
  valid_until?: Date | null;
}

export class GrantNotArchivableError extends Error {
  constructor(readonly status: string) {
    super("仅已停用授权可以归档");
    this.name = "GrantNotArchivableError";
  }
}

export class GrantRepository {
  constructor(private db: Kysely<Database>) {}

  async create(input: CreateGrantInput): Promise<PrincipalGrant> {
    return this.db.transaction().execute(async (trx) => {
      const principal = await trx
        .selectFrom("principal")
        .select("id")
        .where("enterprise_id", "=", input.enterprise_id)
        .where("id", "=", input.principal_id)
        .where("status", "=", "ACTIVE")
        .where("archived_at", "is", null)
        .forKeyShare()
        .executeTakeFirst();
      if (!principal) throw new PrincipalNotActiveError();
      const grant = await trx
        .insertInto("principal_grant")
        .values({
          enterprise_id: input.enterprise_id,
          principal_id: input.principal_id,
          provider: input.provider,
          model_alias: input.model_alias,
          quota_unit: "TOKEN",
          quota_value: input.quota_value,
          allow_overage: input.allow_overage ?? false,
          valid_until: input.valid_until ?? null,
          status: "ACTIVE",
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      // 初始化 quota_counter
      await trx
        .insertInto("quota_counter")
        .values({ grant_id: grant.id })
        .execute();
      return grant;
    });
  }

  async listByPrincipal(enterpriseId: string, principalId: string): Promise<PrincipalGrant[]> {
    return this.db
      .selectFrom("principal_grant")
      .selectAll()
      .where("enterprise_id", "=", enterpriseId)
      .where("principal_id", "=", principalId)
      .where("status", "<>", "ARCHIVED")
      .orderBy("created_at", "desc")
      .execute();
  }

  async archive(enterpriseId: string, grantId: string): Promise<PrincipalGrant | null> {
    return this.db.transaction().execute(async (trx) => {
      const grant = await trx.selectFrom("principal_grant")
        .selectAll()
        .where("enterprise_id", "=", enterpriseId)
        .where("id", "=", grantId)
        .forUpdate()
        .executeTakeFirst();
      if (!grant) return null;
      if (grant.status !== "DISABLED") throw new GrantNotArchivableError(grant.status);
      return trx.updateTable("principal_grant")
        .set({ status: "ARCHIVED", version: sql`version + 1`, updated_at: new Date() })
        .where("enterprise_id", "=", enterpriseId)
        .where("id", "=", grantId)
        .returningAll()
        .executeTakeFirstOrThrow();
    });
  }
}
