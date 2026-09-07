import { sql } from "kysely";
export async function up(db) {
  await sql`CREATE TABLE principal_accounting_assignment (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), enterprise_id uuid NOT NULL,
    principal_id uuid NOT NULL, principal_type text NOT NULL CHECK(principal_type IN ('EMPLOYEE','PROJECT')),
    department_id uuid, owner_principal_id uuid, version integer NOT NULL CHECK(version>0),
    valid_from timestamptz NOT NULL, valid_until timestamptz,
    created_by uuid NOT NULL,
    FOREIGN KEY(enterprise_id,principal_id) REFERENCES principal(enterprise_id,id),
    FOREIGN KEY(enterprise_id,owner_principal_id) REFERENCES principal(enterprise_id,id),
    FOREIGN KEY(enterprise_id,department_id) REFERENCES organization_unit(enterprise_id,id),
    FOREIGN KEY(enterprise_id,created_by) REFERENCES admin_user(enterprise_id,id),
    UNIQUE(enterprise_id,principal_id,version),
    CHECK(valid_until IS NULL OR valid_until>valid_from),
    CHECK((principal_type='EMPLOYEE' AND department_id IS NOT NULL AND owner_principal_id IS NULL)
      OR(principal_type='PROJECT' AND department_id IS NULL AND owner_principal_id IS NOT NULL))
  )`.execute(db);
  await sql`CREATE UNIQUE INDEX principal_accounting_assignment_current
    ON principal_accounting_assignment(enterprise_id,principal_id) WHERE valid_until IS NULL`.execute(
    db,
  );
  await sql`CREATE INDEX principal_accounting_assignment_history
    ON principal_accounting_assignment(enterprise_id,principal_id,valid_from,valid_until)`.execute(
    db,
  );
  await sql`CREATE FUNCTION validate_principal_accounting_assignment() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP='DELETE' THEN RAISE EXCEPTION 'accounting assignment history is immutable'; END IF;
      IF TG_OP='UPDATE' THEN
        IF (to_jsonb(NEW)-'valid_until') IS DISTINCT FROM (to_jsonb(OLD)-'valid_until')
          OR OLD.valid_until IS NOT NULL OR NEW.valid_until IS NULL THEN
          RAISE EXCEPTION 'accounting assignment history is immutable';
        END IF;
      END IF;
      IF NOT EXISTS(SELECT 1 FROM principal WHERE enterprise_id=NEW.enterprise_id AND id=NEW.principal_id AND type=NEW.principal_type) THEN
        RAISE EXCEPTION 'accounting principal type mismatch';
      END IF;
      IF NEW.owner_principal_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM principal WHERE enterprise_id=NEW.enterprise_id AND id=NEW.owner_principal_id AND type='EMPLOYEE') THEN
        RAISE EXCEPTION 'project owner must be an employee';
      END IF;
      RETURN NEW;
    END $$`.execute(db);
  await sql`CREATE TRIGGER principal_accounting_assignment_contract BEFORE INSERT OR UPDATE OR DELETE
    ON principal_accounting_assignment FOR EACH ROW EXECUTE FUNCTION validate_principal_accounting_assignment()`.execute(
    db,
  );
}
export async function down(db) {
  const data =
    await sql`SELECT 1 FROM principal_accounting_assignment LIMIT 1`.execute(
      db,
    );
  if (data.rows.length)
    throw new Error("Cannot remove accounting assignment history");
  await sql`DROP TABLE principal_accounting_assignment`.execute(db);
  await sql`DROP FUNCTION validate_principal_accounting_assignment()`.execute(
    db,
  );
}
