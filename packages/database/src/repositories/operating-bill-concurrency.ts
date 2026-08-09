export class OperatingBillConcurrentModificationError extends Error {}

/** PostgreSQL REPEATABLE READ 遇到并发账期写入时，最多用新事务重取三次快照。 */
export async function withOperatingBillSerializationRetry<T>(
  operation: () => Promise<T>,
): Promise<T> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (!isSerializationFailure(error)) throw error;
    }
  }
  throw new OperatingBillConcurrentModificationError();
}

function isSerializationFailure(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "40001";
}
