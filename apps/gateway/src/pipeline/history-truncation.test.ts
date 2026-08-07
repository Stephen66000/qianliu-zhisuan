import { describe, expect, it, vi } from "vitest";
import {
  readTruncationConfig,
  truncateHistory,
  applyHistoryTruncation,
  buildEffectiveBody,
  type TruncationConfig,
} from "./history-truncation.js";

const cfg = (truncateAtTokens: number, keepTokens: number): TruncationConfig => ({
  truncateAtTokens,
  keepTokens,
});

describe("readTruncationConfig", () => {
  it("都未设 → null（默认关闭，零行为变化）", () => {
    expect(readTruncationConfig({})).toBeNull();
    expect(readTruncationConfig({ GATEWAY_HISTORY_TRUNCATE_AT_TOKENS: "", GATEWAY_HISTORY_KEEP_TOKENS: "" })).toBeNull();
  });

  it("成对设置 → 启用", () => {
    expect(readTruncationConfig({ GATEWAY_HISTORY_TRUNCATE_AT_TOKENS: "120000", GATEWAY_HISTORY_KEEP_TOKENS: "80000" }))
      .toEqual({ truncateAtTokens: 120000, keepTokens: 80000 });
  });

  it("仅设其一 → 启动期抛错（避免半启用）", () => {
    expect(() => readTruncationConfig({ GATEWAY_HISTORY_TRUNCATE_AT_TOKENS: "120000" })).toThrow();
    expect(() => readTruncationConfig({ GATEWAY_HISTORY_KEEP_TOKENS: "80000" })).toThrow();
  });

  it("keep >= truncateAt → 抛错（否则永不触发）", () => {
    expect(() => readTruncationConfig({ GATEWAY_HISTORY_TRUNCATE_AT_TOKENS: "100", GATEWAY_HISTORY_KEEP_TOKENS: "100" })).toThrow();
    expect(() => readTruncationConfig({ GATEWAY_HISTORY_TRUNCATE_AT_TOKENS: "100", GATEWAY_HISTORY_KEEP_TOKENS: "200" })).toThrow();
  });

  it("非法值 → 抛错", () => {
    expect(() => readTruncationConfig({ GATEWAY_HISTORY_TRUNCATE_AT_TOKENS: "abc", GATEWAY_HISTORY_KEEP_TOKENS: "80" })).toThrow();
    expect(() => readTruncationConfig({ GATEWAY_HISTORY_TRUNCATE_AT_TOKENS: "0", GATEWAY_HISTORY_KEEP_TOKENS: "80" })).toThrow();
    expect(() => readTruncationConfig({ GATEWAY_HISTORY_TRUNCATE_AT_TOKENS: "120", GATEWAY_HISTORY_KEEP_TOKENS: "-1" })).toThrow();
  });
});

describe("truncateHistory", () => {
  it("未超阈值 → 原样返回同一数组（零改动）", () => {
    const msgs = [{ role: "user", content: "hi" }];
    expect(truncateHistory(msgs, cfg(100000, 80000))).toBe(msgs);
  });

  it("超阈值 → 保留 system + 末尾，中间丢弃", () => {
    // 每条约 57 token（content ~200 字符）。5 条 ≈ 285 token + sys。
    const big = (c: string) => ({ role: "user" as const, content: c.repeat(200) });
    const msgs = [
      { role: "system", content: "sys" },
      big("A"), big("B"), big("C"), big("D"), big("E"),
    ];
    const out = truncateHistory(msgs, cfg(200, 100));
    // system 必在；末尾若干条保留；中间被丢
    expect(out[0]).toEqual({ role: "system", content: "sys" });
    expect(out[out.length - 1]).toEqual(big("E"));
    expect(out.length).toBeLessThan(msgs.length);
  });

  it("多条 system 全保留", () => {
    const big = (c: string) => ({ role: "user" as const, content: c.repeat(200) });
    const msgs = [
      { role: "system", content: "sys1" },
      { role: "system", content: "sys2" },
      big("A"), big("B"), big("C"), big("D"),
    ];
    const out = truncateHistory(msgs, cfg(150, 80));
    expect(out.filter((m) => (m as { role: string }).role === "system")).toHaveLength(2);
  });

  it("不改原数组（返回新数组）", () => {
    const big = (c: string) => ({ role: "user" as const, content: c.repeat(200) });
    const msgs = [{ role: "system", content: "s" }, big("A"), big("B"), big("C"), big("D")];
    const originalLength = msgs.length;
    const out = truncateHistory(msgs, cfg(150, 80));
    expect(out).not.toBe(msgs);
    expect(msgs).toHaveLength(originalLength); // 原数组未变
  });

  it("tool 配对保护：保留段开头的孤立 tool 消息被丢弃（不产生半边配对）", () => {
    // 构造：assistant 带 tool_calls(id=a) → tool(tool_call_id=a) → user → user
    // 裁剪点若落在 assistant 之后（tool 消息成为保留段开头），应丢弃这条孤立 tool。
    const asst = {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "call_a", type: "function", function: { name: "f", arguments: "{}" } }],
    };
    const tool = { role: "tool", tool_call_id: "call_a", content: "result".repeat(100) };
    const big = (c: string) => ({ role: "user" as const, content: c.repeat(200) });
    const msgs = [
      { role: "system", content: "s" },
      asst,
      tool,
      big("X"), big("Y"), big("Z"), // 末尾这些足够大，把保留段撑满，让 asst 被截掉
    ];
    const out = truncateHistory(msgs, cfg(400, 120));
    // 输出里不应出现 tool_call_id="call_a" 但无对应 assistant 的孤立 tool
    const hasAssistantWithCallA = out.some(
      (m) => (m as { tool_calls?: Array<{ id: string }> }).tool_calls?.some((c) => c.id === "call_a"),
    );
    const hasToolCallA = out.some((m) => (m as { tool_call_id?: string }).tool_call_id === "call_a");
    // 要么都在（配对完整），要么都不在（整组丢弃）；禁止 tool 在而 assistant 不在
    expect(hasToolCallA ? hasAssistantWithCallA : true).toBe(true);
  });

  it("极端兜底：单条消息就超阈值，仍保留末尾一条 + system", () => {
    const huge = { role: "user", content: "x".repeat(10000) }; // 远超任何阈值
    const msgs = [{ role: "system", content: "s" }, huge];
    const out = truncateHistory(msgs, cfg(100, 50));
    expect(out[0]).toEqual({ role: "system", content: "s" });
    expect(out.length).toBeGreaterThanOrEqual(2); // system + 至少一条
  });

  it("空数组原样返回", () => {
    expect(truncateHistory([], cfg(100, 50))).toEqual([]);
  });
});

describe("applyHistoryTruncation", () => {
  it("config=null → 原样返回（默认关闭）", () => {
    const msgs = [{ role: "user", content: "hi" }];
    expect(applyHistoryTruncation(msgs, null)).toBe(msgs);
  });

  it("config 启用且超阈值 → 返回裁剪后数组", () => {
    const big = (c: string) => ({ role: "user" as const, content: c.repeat(200) });
    const msgs = [{ role: "system", content: "s" }, big("A"), big("B"), big("C"), big("D")];
    const out = applyHistoryTruncation(msgs, cfg(150, 80));
    expect(out).not.toBe(msgs);
    expect(out.length).toBeLessThan(msgs.length);
  });

  it("F-1：全 system 且超阈值时记 warn（消除观测盲区），且原样返回不裁", () => {
    const log = { info: vi.fn(), warn: vi.fn() };
    const sysMsgs = [
      { role: "system", content: "s".repeat(800) },
      { role: "system", content: "s2".repeat(800) },
    ];
    const out = applyHistoryTruncation(sysMsgs, cfg(50, 20), log, "req-1");
    expect(out).toBe(sysMsgs); // 全 system 无可裁，原样返回
    expect(log.warn).toHaveBeenCalledOnce();
    expect(log.info).not.toHaveBeenCalled(); // 未实际裁剪，不记 info
  });
});

describe("buildEffectiveBody（G-3：预占与发送口径一致）", () => {
  it("chat + 截断启用且超阈值 → messages 被截断，其余字段保留", () => {
    const big = (c: string) => ({ role: "user" as const, content: c.repeat(200) });
    const body = { model: "m", messages: [{ role: "system", content: "s" }, big("A"), big("B"), big("C"), big("D")] };
    const eff = buildEffectiveBody(body, "chat", cfg(150, 80));
    expect(eff.model).toBe("m"); // 其余字段保留
    expect(eff.messages.length).toBeLessThan(body.messages.length); // 被截
    expect(eff.messages[0]).toEqual({ role: "system", content: "s" }); // system 保留
  });

  it("responses → 原样返回（不截断）", () => {
    const body = { model: "m", messages: [{ role: "user", content: "x".repeat(10000) }] };
    const eff = buildEffectiveBody(body, "responses", cfg(100, 50));
    expect(eff).toBe(body); // 同一引用，未处理
  });

  it("config=null → chat 也原样（默认关闭）", () => {
    const body = { model: "m", messages: [{ role: "user", content: "x".repeat(10000) }] };
    const eff = buildEffectiveBody(body, "chat", null);
    // messages 被规范化但未截断（config=null 时 applyHistoryTruncation 原样返回）
    expect(eff.messages).toBe(body.messages);
  });

  it("截断后的 effectiveBody 即为预占/发送共用体（口径一致）", () => {
    // G-3 核心断言：buildEffectiveBody 返回值的 messages 就是截断后的，
    // real-pipeline 用同一个 effectiveBody 既调 adapter 又调 reserveQuota。
    const big = (c: string) => ({ role: "user" as const, content: c.repeat(200) });
    const body = { model: "m", messages: [big("A"), big("B"), big("C"), big("D")] };
    const eff = buildEffectiveBody(body, "chat", cfg(150, 80));
    // 截断发生了
    expect(eff.messages.length).toBeLessThan(body.messages.length);
    // effectiveBody 是新对象（不污染原 body）
    expect(eff).not.toBe(body);
  });
});
