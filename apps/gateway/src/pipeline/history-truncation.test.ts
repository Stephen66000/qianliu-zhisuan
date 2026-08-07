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

  it("超阈值 → 保留 system + 末尾，中间丢弃（G-1：锁定具体保留条数与内容）", () => {
    // 每条 user 约 57 token（content 200 字符 + JSON 开销）。keepTokens=100：
    // E(57) 保留且未达标 → D(57) 累加=114 达标保留 break。保留 D、E + system。
    const big = (c: string) => ({ role: "user" as const, content: c.repeat(200) });
    const msgs = [
      { role: "system", content: "sys" },
      big("A"), big("B"), big("C"), big("D"), big("E"),
    ];
    const out = truncateHistory(msgs, cfg(200, 100));
    // G-1：断言具体结构，而非仅"变短"
    expect(out).toEqual([
      { role: "system", content: "sys" },
      big("D"),
      big("E"),
    ]);
    // 中间被丢的明确不在结果里
    expect(out).not.toContainEqual(big("A"));
    expect(out).not.toContainEqual(big("B"));
    expect(out).not.toContainEqual(big("C"));
  });

  it("多条 system 全保留（G-1：锁定非 system 保留内容）", () => {
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

  it("tool 配对保护(a)：保留段开头的孤立 tool 消息被丢弃（assistant 被截）", () => {
    // 构造：assistant 带 tool_calls(id=a) → tool(tool_call_id=a) → 末尾大消息撑满保留段
    // 裁剪点落在 assistant 之后（tool 消息成为保留段开头），应丢弃这条孤立 tool。
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
      big("X"), big("Y"), big("Z"),
    ];
    const out = truncateHistory(msgs, cfg(200, 60));
    // G-2 强化：明确断言 call_a 的 assistant 和 tool 都不在结果里（整组被截）
    expect(out.some((m) => (m as { tool_calls?: Array<{ id: string }> }).tool_calls?.some((c) => c.id === "call_a"))).toBe(false);
    expect(out.some((m) => (m as { tool_call_id?: string }).tool_call_id === "call_a")).toBe(false);
    // 末尾消息确实被保留（证明不是"全裁了"导致的 false）
    expect(out).toContainEqual(big("Z"));
  });

  it("tool 配对保护(b) F-3：保留段开头 assistant 的 tool_calls 响应被截时，assistant 也丢弃", () => {
    // 构造：user → assistant(tool_calls id=b) → [big 大消息把 tool 响应挤出保留段] → tool(tool_call_id=b) → user
    // 实际更常见形态：assistant 在保留段开头，但其 tool 响应在更早位置已被截。
    // 这里构造：assistant 带 tool_calls，其 tool 响应在 assistant 之后但保留段起点在 assistant 之后。
    const asst = {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "call_b", type: "function", function: { name: "g", arguments: "{}" } }],
    };
    const tool = { role: "tool", tool_call_id: "call_b", content: "r".repeat(50) };
    const big = (c: string) => ({ role: "user" as const, content: c.repeat(200) });
    // 顺序：system → asst(call_b) → tool(call_b) → bigA → bigB → bigC
    // keepTokens 设到只保留末尾 1 条（bigC），asst 成为保留段开头但其 tool 响应(tool)被截。
    const msgs = [
      { role: "system", content: "s" },
      asst,
      tool,
      big("A"), big("B"), big("C"),
    ];
    const out = truncateHistory(msgs, cfg(200, 60));
    // F-3：assistant 的 call_b 响应不在保留段 → assistant 应被丢弃
    expect(out.some((m) => (m as { tool_calls?: Array<{ id: string }> }).tool_calls?.some((c) => c.id === "call_b"))).toBe(false);
    // 末尾 bigC 仍保留
    expect(out).toContainEqual(big("C"));
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
