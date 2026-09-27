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

  it("结构校验完整：id-only、缺字段、字段类型错误、非法币种/枚举/布尔一律整体忽略（R1）", () => {
    const storage = memoryStorage();
    const key = draftAutosaveKey(ENTERPRISE_A, CUTOVER);
    const costRow = {
      id: "cost-1", resourceId: ENTERPRISE_A, accountCurrency: "CNY",
      costAmount: "40.4572", costUntilLocal: "2026-09-10T12:00",
    };
    // 六类行的完整合法样例（含购买行 kind/autoRenew 与旧记录 resolution）。
    const validDraft = {
      ...emptyDraftState(),
      historicalApiCosts: [costRow],
      codingPlanPurchases: [{
        id: "p-1", resourceId: ENTERPRISE_A, kind: "PURCHASE", productName: "Plan",
        accountAmount: "100", accountCurrency: "CNY", cashPaidCny: "100.00",
        servicePeriodStart: "2026-09-01", servicePeriodEnd: "2026-09-30",
        occurredAtLocal: "2026-09-01T10:00", externalReference: "P-1", autoRenew: true,
        description: "", evidenceRef: "", sourceRecordId: "", carryoverSnapshotId: "",
        recordIdempotencyKey: "idem-key-1",
      }],
      legacyResolutions: [{
        id: "l-1", legacyRecordId: ENTERPRISE_A, resourceId: ENTERPRISE_A,
        resolution: "MIGRATED", financeEventId: "", migratedExternalReference: "ORD-1",
        reason: "", evidenceRef: "",
      }],
    };
    const brokenRows: unknown[] = [
      // id-only（旧版本/损坏行的典型形态）。
      { id: "cost-1" },
      // 缺字段。
      { id: "cost-1", resourceId: ENTERPRISE_A, accountCurrency: "CNY", costAmount: "40.4572" },
      // 字段类型错误（金额被写成数字）。
      { ...costRow, costAmount: 40.4572 },
      // 字段类型错误（布尔字段被写成字符串）。
      { ...validDraft.codingPlanPurchases[0], autoRenew: "true" },
      // 非法币种。
      { ...costRow, accountCurrency: "EUR" },
      // 非法购买类型。
      { ...validDraft.codingPlanPurchases[0], kind: "SUBSCRIPTION" },
      // 非法旧记录关闭决定。
      { ...validDraft.legacyResolutions[0], resolution: "CLOSED" },
    ];
    for (const broken of brokenRows) {
      // 故意把坏行放进它所属的分区；分区不匹配也会被判为结构不兼容，同样返回 null。
      const target = (broken === brokenRows[3] ? "codingPlanPurchases"
        : broken === brokenRows[5] ? "codingPlanPurchases"
        : broken === brokenRows[6] ? "legacyResolutions" : "historicalApiCosts") as
        keyof typeof validDraft;
      storage.setItem(key, JSON.stringify({
        schema_version: DRAFT_AUTOSAVE_SCHEMA_VERSION, enterprise_id: ENTERPRISE_A,
        cutover_at: CUTOVER, saved_at: "2026-09-27T08:00:00.000Z",
        draft: { ...validDraft, [target]: [broken] },
      }));
      expect(loadDraftAutosave(storage, ENTERPRISE_A, CUTOVER)).toBeNull();
    }
    // 完整合法结构恢复成功（不做金额转换、不部分恢复）。
    storage.setItem(key, JSON.stringify({
      schema_version: DRAFT_AUTOSAVE_SCHEMA_VERSION, enterprise_id: ENTERPRISE_A,
      cutover_at: CUTOVER, saved_at: "2026-09-27T08:00:00.000Z", draft: validDraft,
    }));
    expect(loadDraftAutosave(storage, ENTERPRISE_A, CUTOVER)).toEqual(validDraft);
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

describe("既有 localStorage v1 草稿兼容（管理员声明跨切换周期改造）", () => {
  it("已自动保存的六类行草稿（含跨切换隐藏字段）刷新后完整恢复，不丢行不丢字段", () => {
    const storage = memoryStorage();
    const savedDraft: ActivationDraftState = {
      ...emptyDraftState(),
      historicalApiRecharges: [{
        id: "row-1", resourceId: ENTERPRISE_A, accountCurrency: "CNY", accountAmount: "50",
        cashPaidCny: "50.00", occurredAtLocal: "2026-09-05T10:00", externalReference: "DS-9",
      }],
      historicalApiCosts: [{
        id: "cost-1", resourceId: ENTERPRISE_A, accountCurrency: "CNY",
        costAmount: "40.4572", costUntilLocal: "2026-09-10T12:00",
      }],
      codingPlanPurchases: [{
        id: "p-1", resourceId: ENTERPRISE_A, kind: "RENEWAL", productName: "GLM Coding Plan",
        accountAmount: "20", accountCurrency: "CNY", cashPaidCny: "20.00",
        servicePeriodStart: "2026-09-25", servicePeriodEnd: "2026-10-24",
        occurredAtLocal: "2026-09-25T10:00", externalReference: "ZP-R1", autoRenew: true,
        description: "", evidenceRef: "", sourceRecordId: "", carryoverSnapshotId: "",
        recordIdempotencyKey: "idem-zp-r1",
      }],
      codingPlanCarryovers: [{
        id: "carry-1", resourceId: ENTERPRISE_A, productName: "GLM Coding Plan",
        periodStart: "2026-08-26", periodEnd: "2026-09-25",
        snapshotId: "", description: "", evidenceRef: "",
      }],
      legacyResolutions: [{
        id: "legacy-1", legacyRecordId: ENTERPRISE_A, resourceId: ENTERPRISE_A,
        resolution: "MIGRATED", financeEventId: "", migratedExternalReference: "ORD-1",
        reason: "", evidenceRef: "",
      }],
    };
    expect(saveDraftAutosave(storage, savedDraft, ENTERPRISE_A, CUTOVER, "2026-09-27T09:00:00.000Z"))
      .toBe(true);
    // 恢复走同一 v1 key + schema_version，六行全部原样回来。
    expect(loadDraftAutosave(storage, ENTERPRISE_A, CUTOVER)).toEqual(savedDraft);
  });
});
