/**
 * 初始化草稿编辑器 UI 测试。
 *
 * WP4-S3 / AFR-01：API 资金草稿区（API 期初余额、历史 API 充值、历史 API 消耗）的
 * 编辑 UI 已退役——后端预检合同为纯套餐（activation-contracts.ts 显式拒绝三类 API
 * 草稿键），前端不再提供必然失败的 API 资金表单；原「历史 API 充值行只保留六项」等
 * API 行用例随该表单一并删除。Coding Plan 购买/续费、跨切换周期与旧记录关闭用例保留。
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { emptyDraftState, newLocalRowId, type ActivationDraftState } from "./activation-draft-model";
import { ActivationDraftEditor } from "./ActivationDraftEditor";

const RESOURCE = "11111111-1111-4111-8111-111111111111";

function renderEditor(state: ActivationDraftState = emptyDraftState()) {
  return render(
    <ActivationDraftEditor
      issues={[]}
      legacySuggestions={[]}
      onChange={() => undefined}
      readOnly={false}
      resourceOptions={[
        { id: RESOURCE, mode: "API", label: "DeepSeek 主账号" },
        { id: "22222222-2222-4222-8222-222222222222", mode: "CODING_PLAN", label: "GLM 套餐" },
      ]}
      state={state}
    />,
  );
}

// AFR-01：API 资金事实不再从初始化草稿 UI 新增；即使旧本机草稿恢复了 API 行，
// 也不得重新出现对应编辑入口（草稿行只能通过「清除本机草稿」处置）。
describe("API 资金草稿区退役", () => {
  it("不提供 API 期初、历史充值与历史消耗的编辑入口", () => {
    renderEditor({
      ...emptyDraftState(),
      apiOpeningBalances: [{
        id: newLocalRowId(), resourceId: RESOURCE, accountCurrency: "CNY", accountAmount: "0",
        description: "", evidenceRef: "", sourceRecordId: "",
      }],
      historicalApiRecharges: [{
        id: newLocalRowId(), resourceId: RESOURCE, accountCurrency: "CNY", accountAmount: "50",
        cashPaidCny: "50.00", occurredAtLocal: "2026-09-05T10:00", externalReference: "DS-ORDER-9",
      }],
      historicalApiCosts: [{
        id: newLocalRowId(), resourceId: RESOURCE, accountCurrency: "CNY",
        costAmount: "40.4572", costUntilLocal: "2026-09-10T12:00",
      }],
    });
    for (const label of ["添加期初行", "添加历史充值", "添加历史消耗"]) {
      expect(screen.queryByRole("button", { name: label })).toBeNull();
    }
    for (const label of ["期初余额", "到账金额", "实际消耗金额", "充值订单号"]) {
      expect(screen.queryByLabelText(label)).toBeNull();
    }
    expect(screen.queryByTestId("draft-section-openings")).toBeNull();
    expect(screen.queryByTestId("draft-section-recharges")).toBeNull();
    expect(screen.queryByTestId("draft-section-costs")).toBeNull();
  });

  it("Coding Plan 购买/续费草稿区不受影响（仍提供事实说明与证据引用）", () => {
    renderEditor({
      ...emptyDraftState(),
      codingPlanPurchases: [{
        id: newLocalRowId(), resourceId: "22222222-2222-4222-8222-222222222222",
        kind: "RENEWAL", productName: "GLM Coding Plan", accountAmount: "20",
        accountCurrency: "CNY", cashPaidCny: "20.00", servicePeriodStart: "2026-09-25",
        servicePeriodEnd: "", occurredAtLocal: "2026-09-25T10:00", externalReference: "ZP-R1",
        autoRenew: true, description: "", evidenceRef: "", sourceRecordId: "",
        carryoverSnapshotId: "", recordIdempotencyKey: "idem-key-1",
      }],
    });
    expect(screen.getByTestId("draft-section-purchases")).toBeInTheDocument();
    expect(screen.getByLabelText("事实说明")).toBeDefined();
    expect(screen.getByLabelText("证据引用")).toBeDefined();
  });
});

describe("跨切换周期行（管理员声明）：只保留四项", () => {
  function stateWithCarryoverRow(): ActivationDraftState {
    return {
      ...emptyDraftState(),
      codingPlanCarryovers: [{
        id: newLocalRowId(), resourceId: RESOURCE, productName: "GLM Coding Plan",
        periodStart: "2026-08-26", periodEnd: "2026-09-25",
        snapshotId: "", description: "", evidenceRef: "",
      }],
    };
  }

  it("显示厂商资源、产品名称、周期开始日、周期结束日", () => {
    renderEditor(stateWithCarryoverRow());
    for (const label of ["产品名称", "周期开始日", "周期结束日"]) {
      expect(screen.getByLabelText(label)).toBeDefined();
    }
  });

  it("不再出现快照引用、事实说明、证据引用输入框", () => {
    renderEditor(stateWithCarryoverRow());
    expect(screen.queryByLabelText("快照引用")).toBeNull();
    expect(screen.queryAllByLabelText("事实说明")).toHaveLength(0);
    expect(screen.queryAllByLabelText("证据引用")).toHaveLength(0);
  });
});
