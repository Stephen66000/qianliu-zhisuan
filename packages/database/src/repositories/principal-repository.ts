/**
 * Principal 仓储 —— 员工/项目统一主体的 CRUD（W02）。
 *
 * 依据：TRD §5.2。enterprise_id 贯穿所有查询。
 * 停用语义：status=DISABLED；停用时上层应同步撤销 Key（W03）。
 */
import type { Kysely, Selectable } from "kysely";
import type { Database, PrincipalTable } from "../kysely.js";

export type Principal = Selectable<PrincipalTable>;

export interface CreatePrincipalInput {
  enterprise_id: string;
  type: "EMPLOYEE" | "PROJECT";
  name: string;
  department_label?: string | null;
}

export interface UpdatePrincipalInput {
  name?: string;
  department_label?: string | null;
  status?: "ACTIVE" | "DISABLED";
}

export class PrincipalRepository {
  constructor(private db: Kysely<Database>) {}

  async list(enterpriseId: string, opts?: { type?: "EMPLOYEE" | "PROJECT" }): Promise<Principal[]> {
    let q = this.db.selectFrom("principal").selectAll().where("enterprise_id", "=", enterpriseId);
    if (opts?.type) q = q.where("type", "=", opts.type);
    return q.orderBy("created_at", "desc").execute();
  }

  async findById(enterpriseId: string, id: string): Promise<Principal | undefined> {
    return this.db
      .selectFrom("principal")
      .selectAll()
      .where("enterprise_id", "=", enterpriseId)
      .where("id", "=", id)
      .executeTakeFirst();
  }

  async create(input: CreatePrincipalInput): Promise<Principal> {
    return this.db
      .insertInto("principal")
      .values({
        enterprise_id: input.enterprise_id,
        type: input.type,
        name: input.name,
        department_label: input.department_label ?? null,
        status: "ACTIVE",
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  async update(enterpriseId: string, id: string, input: UpdatePrincipalInput): Promise<Principal> {
    return this.db
      .updateTable("principal")
      .set({ ...input, updated_at: new Date() })
      .where("enterprise_id", "=", enterpriseId)
      .where("id", "=", id)
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  /** 软停用：status=DISABLED。不删除（历史保留，PRD §6.4 L188）。 */
  async disable(enterpriseId: string, id: string): Promise<Principal> {
    return this.update(enterpriseId, id, { status: "DISABLED" });
  }

  async reactivate(enterpriseId: string, id: string): Promise<Principal> {
    return this.update(enterpriseId, id, { status: "ACTIVE" });
  }
}
