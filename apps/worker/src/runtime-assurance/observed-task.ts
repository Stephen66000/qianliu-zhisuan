import { OperationalFaultRepository, type Database } from "@qianliu/database";
import type { Kysely } from "kysely";

/** Keep a process-local pending record if the database itself is temporarily unavailable. */
export function createTaskObserver(
  db: Kysely<Database>,
  enterpriseId?: string,
) {
  const repository = new OperationalFaultRepository(db);
  const pending = new Map<string, { title: string; at: Date }>();
  return async function observe<T>(
    task: string,
    title: string,
    work: () => Promise<T>,
    succeeded: (value: T) => boolean | null = () => true,
  ): Promise<T> {
    const write = async (ok: boolean) => {
      try {
        const prior = pending.get(task);
        if (prior) {
          await repository.record(
            task,
            prior.title,
            false,
            prior.at,
            enterpriseId,
          );
          pending.delete(task);
        }
        await repository.record(task, title, ok, new Date(), enterpriseId);
      } catch {
        if (!ok && !pending.has(task))
          pending.set(task, { title, at: new Date() });
        console.error(
          JSON.stringify({ event: "task_fault_record_unavailable", task }),
        );
      }
    };
    try {
      const result = await work();
      const success = succeeded(result);
      if (success !== null) await write(success);
      return result;
    } catch (error) {
      await write(false);
      throw error;
    }
  };
}
