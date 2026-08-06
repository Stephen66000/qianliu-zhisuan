/** POOL-033：池化权限合并纯函数的单元测试（进变异测试 ratchet）。 */
import { describe, expect, it } from "vitest";
import { computeAllowedModelIds } from "./principal-access-config-repository.js";

describe("POOL-033 池化白名单合并", () => {
  it("手工 ∪ 受管 ∪ 池内未禁用型号，去重排序", () => {
    expect(computeAllowedModelIds({
      manualIds: ["manual-1", "shared"],
      managedAssignmentModelIds: ["managed-1", "shared"],
      poolModelIds: ["pool-1", "pool-2", "shared"],
      disabledModelIds: [],
    })).toEqual(["managed-1", "manual-1", "pool-1", "pool-2", "shared"]);
  });

  it("池内型号被显式禁用时从白名单剔除", () => {
    expect(computeAllowedModelIds({
      manualIds: [],
      managedAssignmentModelIds: [],
      poolModelIds: ["pool-1", "pool-2", "pool-3"],
      disabledModelIds: ["pool-2"],
    })).toEqual(["pool-1", "pool-3"]);
  });

  it("禁用不影响手工与受管型号（跨来源）", () => {
    expect(computeAllowedModelIds({
      manualIds: ["manual-1"],
      managedAssignmentModelIds: ["managed-1"],
      poolModelIds: ["pool-1"],
      disabledModelIds: ["pool-1", "unrelated"],
    })).toEqual(["managed-1", "manual-1"]);
  });

  it("全空输入返回空数组", () => {
    expect(computeAllowedModelIds({
      manualIds: [],
      managedAssignmentModelIds: [],
      poolModelIds: [],
      disabledModelIds: [],
    })).toEqual([]);
  });

  it("禁用清单中的型号即使同时在手工/受管/池三处也只剔池内部分", () => {
    // 同一型号被禁用时，若它同时是手工授权，手工来源仍应保留（池外来源不受禁用影响）。
    expect(computeAllowedModelIds({
      manualIds: ["shared-model"],
      managedAssignmentModelIds: ["shared-model"],
      poolModelIds: ["shared-model"],
      disabledModelIds: ["shared-model"],
    })).toEqual(["shared-model"]);
  });
});
