/**
 * 功能 A：初始化草稿本机自动保存——纯函数定向测试（2026-09-27）。
 *
 * 覆盖：保存/恢复往返、企业 + 切换时点隔离、坏数据忽略（无效 JSON、版本不匹配、
 * 企业不匹配、结构不兼容）、清除、存储异常不抛出。
 */
import { describe, expect, it } from "vitest";

import { emptyDraftState, type ActivationDraftState } from "./activation-draft-model";
import {
  clearDraftAutosave, draftAutosaveKey, DRAFT_AUTOSAVE_SCHEMA_VERSION,
  loadDraftAutosave, saveDraftAutosave, type DraftStorage,
} from "./draft-autosave";

const ENTERPRISE_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ENTERPRISE_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CUTOVER = "2026-08-31T16:00:00.000Z";

function memoryStorage(): DraftStorage & { dump: () => Map<string, string> } {
  const map = new Map<string, string>();
  return {
    dump: () => map,
    getItem: (key) => map.get(key) ?? null,
    removeItem: (key) => { map.delete(key); },
    setItem: (key, value) => { map.set(key, value); },
  };
}

function sampleDraft(): ActivationDraftState {
  return {
    ...emptyDraftState(),
    historicalApiRecharges: [{
      id: "row-1", resourceId: ENTERPRISE_A, accountCurrency: "CNY", accountAmount: "50",
      cashPaidCny: "50.00", occurredAtLocal: "2026-09-05T10:00", externalReference: "DS-9",
    }],
    historicalApiCosts: [{
      id: "cost-1", resourceId: ENTERPRISE_A, accountCurrency: "CNY",
      costAmount: "40.4572", costUntilLocal: "2026-09-10T12:00",
    }],
  };
}

describe("草稿本机自动保存", () => {
  it("key 按协议版本 + 企业 + 切换时点隔离", () => {
    const keyA = draftAutosaveKey(ENTERPRISE_A, CUTOVER);
    expect(keyA).toContain(`v${DRAFT_AUTOSAVE_SCHEMA_VERSION}`);
    expect(keyA).toContain(ENTERPRISE_A);
    expect(keyA).toContain(CUTOVER);
    expect(keyA).not.toBe(draftAutosaveKey(ENTERPRISE_B, CUTOVER));
    expect(keyA).not.toBe(draftAutosaveKey(ENTERPRISE_A, "2026-09-01T16:00:00.000Z"));
  });

  it("保存后恢复得到相同草稿（刷新恢复）", () => {
    const storage = memoryStorage();
    expect(saveDraftAutosave(storage, sampleDraft(), ENTERPRISE_A, CUTOVER, "2026-09-27T08:00:00.000Z"))
      .toBe(true);
    expect(loadDraftAutosave(storage, ENTERPRISE_A, CUTOVER)).toEqual(sampleDraft());
  });

  it("企业或切换时点不同不互相恢复", () => {
    const storage = memoryStorage();
    saveDraftAutosave(storage, sampleDraft(), ENTERPRISE_A, CUTOVER, "2026-09-27T08:00:00.000Z");
    expect(loadDraftAutosave(storage, ENTERPRISE_B, CUTOVER)).toBeNull();
    expect(loadDraftAutosave(storage, ENTERPRISE_A, "2026-09-01T16:00:00.000Z")).toBeNull();
  });

  it("无效 JSON、版本不匹配、结构不兼容一律忽略并回退 null", () => {
    const storage = memoryStorage();
    const key = draftAutosaveKey(ENTERPRISE_A, CUTOVER);
    const cases = [
      "not-json{",
      JSON.stringify({ schema_version: 0, enterprise_id: ENTERPRISE_A, cutover_at: CUTOVER,
        saved_at: "x", draft: emptyDraftState() }),
      JSON.stringify({ schema_version: DRAFT_AUTOSAVE_SCHEMA_VERSION, enterprise_id: ENTERPRISE_B,
        cutover_at: CUTOVER, saved_at: "x", draft: emptyDraftState() }),
      JSON.stringify({ schema_version: DRAFT_AUTOSAVE_SCHEMA_VERSION, enterprise_id: ENTERPRISE_A,
        cutover_at: CUTOVER, saved_at: "x", draft: { apiOpeningBalances: "not-an-array" } }),
      JSON.stringify({ schema_version: DRAFT_AUTOSAVE_SCHEMA_VERSION, enterprise_id: ENTERPRISE_A,
        cutover_at: CUTOVER, saved_at: "x", draft: { apiOpeningBalances: [{ noId: true }] } }),
      JSON.stringify({ schema_version: DRAFT_AUTOSAVE_SCHEMA_VERSION, enterprise_id: ENTERPRISE_A,
        cutover_at: CUTOVER, saved_at: "x" }),
    ];
    for (const raw of cases) {
      storage.setItem(key, raw);
      expect(loadDraftAutosave(storage, ENTERPRISE_A, CUTOVER)).toBeNull();
    }
  });

  it("清除后不再恢复；清除异常被吞掉", () => {
    const storage = memoryStorage();
    saveDraftAutosave(storage, sampleDraft(), ENTERPRISE_A, CUTOVER, "2026-09-27T08:00:00.000Z");
    clearDraftAutosave(storage, ENTERPRISE_A, CUTOVER);
    expect(loadDraftAutosave(storage, ENTERPRISE_A, CUTOVER)).toBeNull();
    expect(() => clearDraftAutosave(storage, ENTERPRISE_B, CUTOVER)).not.toThrow();
  });

  it("存储写入失败返回 false、读取失败返回 null，绝不抛出", () => {
    const throwing: DraftStorage = {
      getItem: () => { throw new Error("quota"); },
      setItem: () => { throw new Error("quota"); },
      removeItem: () => { throw new Error("quota"); },
    };
    expect(saveDraftAutosave(throwing, sampleDraft(), ENTERPRISE_A, CUTOVER, "x")).toBe(false);
    expect(loadDraftAutosave(throwing, ENTERPRISE_A, CUTOVER)).toBeNull();
    expect(() => clearDraftAutosave(throwing, ENTERPRISE_A, CUTOVER)).not.toThrow();
  });

  it("storage 为 null（SSR/不可用）时全部安全退化为空操作", () => {
    expect(loadDraftAutosave(null, ENTERPRISE_A, CUTOVER)).toBeNull();
    expect(saveDraftAutosave(null, sampleDraft(), ENTERPRISE_A, CUTOVER, "x")).toBe(false);
    expect(() => clearDraftAutosave(null, ENTERPRISE_A, CUTOVER)).not.toThrow();
  });
});
