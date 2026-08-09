import { describe, expect, it, vi } from "vitest";
import {
  OperatingBillConcurrentModificationError,
  withOperatingBillSerializationRetry,
} from "./operating-bill-concurrency.js";

describe("POOL-043 经营账单序列化冲突重试", () => {
  it("无冲突时只执行一次并返回结果", async () => {
    const operation = vi.fn().mockResolvedValue("closed");
    await expect(withOperatingBillSerializationRetry(operation)).resolves.toBe("closed");
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it("仅重试 PostgreSQL 40001，并由新事务第三次成功", async () => {
    const operation = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error("serialize-1"), { code: "40001" }))
      .mockRejectedValueOnce({ code: "40001" })
      .mockResolvedValue("fresh-snapshot");
    await expect(withOperatingBillSerializationRetry(operation)).resolves.toBe("fresh-snapshot");
    expect(operation).toHaveBeenCalledTimes(3);
  });

  it("非序列化错误原样抛出且不重试", async () => {
    const original = Object.assign(new Error("constraint"), { code: "23505" });
    const operation = vi.fn().mockRejectedValue(original);
    await expect(withOperatingBillSerializationRetry(operation)).rejects.toBe(original);
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it.each([null, "40001", new Error("missing-code")])(
    "非对象或无 code 的异常 %s 也必须原样抛出",
    async (original) => {
      const operation = vi.fn().mockRejectedValue(original);
      let caught: unknown = Symbol("not-thrown");
      try {
        await withOperatingBillSerializationRetry(operation);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBe(original);
      expect(operation).toHaveBeenCalledTimes(1);
    },
  );

  it("三次 40001 后转换为明确的可重试并发错误", async () => {
    const operation = vi.fn().mockRejectedValue({ code: "40001" });
    await expect(withOperatingBillSerializationRetry(operation))
      .rejects.toBeInstanceOf(OperatingBillConcurrentModificationError);
    expect(operation).toHaveBeenCalledTimes(3);
  });
});
