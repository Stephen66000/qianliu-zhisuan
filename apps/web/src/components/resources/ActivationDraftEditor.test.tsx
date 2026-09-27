/**
 * 历史 API 充值表单最小修复（2026-09-27）UI 测试。
 *
 * 覆盖：
 *  - 充值行只显示六项输入：厂商资源、币种、到账金额、人民币实付、充值时间、充值订单号；
 *  - 不再出现「来源旧记录、事实说明、证据引用、幂等键」输入框；
 *  - 能生成合法提交数据（载荷只含六项，见 activation-draft-model.test.ts）。
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { emptyDraftState, newLocalRowId, type ActivationDraftState } from "./activation-draft-model";
import { ActivationDraftEditor } from "./ActivationDraftEditor";

const RESOURCE = "11111111-1111-4111-8111-111111111111";

function stateWithRechargeRow(): ActivationDraftState {
  return {
    ...emptyDraftState(),
    historicalApiRecharges: [{
      id: newLocalRowId(), resourceId: RESOURCE, accountCurrency: "CNY", accountAmount: "50",
      cashPaidCny: "50.00", occurredAtLocal: "2026-09-05T10:00", externalReference: "DS-ORDER-9",
    }],
  };
}

function renderEditor(state: ActivationDraftState = stateWithRechargeRow()) {
  return render(
    <ActivationDraftEditor
      cutoverAt="2026-08-31T16:00:00.000Z"
      issues={[]}
      legacySuggestions={[]}
      onChange={() => undefined}
      readOnly={false}
      requiredAccounts={[]}
      resourceOptions={[{ id: RESOURCE, mode: "API", label: "DeepSeek 主账号" }]}
      state={state}
    />,
  );
}

describe("历史 API 充值行：只保留六项", () => {
  it("显示厂商资源、币种、到账金额、人民币实付、充值时间、充值订单号", () => {
    renderEditor();
    for (const label of ["厂商资源", "币种", "到账金额", "人民币实付", "充值时间", "充值订单号"]) {
      expect(screen.getByLabelText(label)).toBeDefined();
    }
  });

  it("不再出现来源旧记录、事实说明、证据引用、幂等键输入框", () => {
    renderEditor();
    for (const label of ["来源旧记录", "事实说明", "证据引用", "幂等键"]) {
      expect(screen.queryByLabelText(label)).toBeNull();
    }
  });

  it("期初与购买等其他区块不受影响（仍提供事实说明）", () => {
    renderEditor({
      ...stateWithRechargeRow(),
      apiOpeningBalances: [{
        id: newLocalRowId(), resourceId: RESOURCE, accountCurrency: "CNY", accountAmount: "0",
        description: "", evidenceRef: "", sourceRecordId: "",
      }],
    });
    expect(screen.getByLabelText("事实说明")).toBeDefined();
    expect(screen.getByLabelText("证据引用")).toBeDefined();
  });
});

describe("历史 API 消耗行（0084）：只保留四项", () => {
  function stateWithCostRow(): ActivationDraftState {
    return {
      ...emptyDraftState(),
      historicalApiCosts: [{
        id: newLocalRowId(), resourceId: RESOURCE, accountCurrency: "CNY",
        costAmount: "40.4572", costUntilLocal: "2026-09-10T12:00",
      }],
    };
  }

  it("显示厂商资源、币种、实际消耗金额、成本截止时间与固定期间开始", () => {
    renderEditor(stateWithCostRow());
    for (const label of ["厂商资源", "币种", "实际消耗金额", "成本截止时间", "期间开始（固定）"]) {
      expect(screen.getByLabelText(label)).toBeDefined();
    }
  });

  it("不出现事实说明、证据引用、幂等键或充值订单号输入框", () => {
    renderEditor(stateWithCostRow());
    expect(screen.queryByLabelText("充值订单号")).toBeNull();
    expect(screen.queryAllByLabelText("事实说明")).toHaveLength(0);
    expect(screen.queryAllByLabelText("证据引用")).toHaveLength(0);
  });
});
