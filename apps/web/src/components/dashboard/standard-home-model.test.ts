/**
 * 标准版首页展示模型单测（V14-C2 F-C/F-D 回归 + V14-C4 G01/G02 双期可比性/费用完整性）。
 * periodChangePercent：定点 BigInt 百分比（大数精度、小数串、非法输入、零/负上期）。
 * buildOverviewCards：双期可比性与缺口文案的业务规则（G02a 有界变异的被保护对象）。
 */
import { describe, expect, it } from "vitest";

import type { StandardHomeSummary } from "../../api/types";
import {
  buildOverviewCards,
  costGapLabel,
  moneyChangePercent,
  periodChangePercent,
  previousTokenQualityNote,
  tokenPeriodComparable,
  tokenQualityLabel,
} from "./standard-home-model";

describe("periodChangePercent（定点 BigInt）", () => {
  it("常规百分比与既有展示一致（+20.0% / +8.0%）", () => {
    expect(periodChangePercent("1000000000", "833000000")).toBe("+20.0%");
    expect(periodChangePercent("12800.00000000", "11851.85000000")).toBe("+8.0%");
  });

  it("超过 2^53 的金额/Token 不失精度（V14-C2 F-C）", () => {
    // 10,000,000,000,000,000,000 → 9,000,000,000,000,000,000 = +11.111…%
    expect(periodChangePercent("10000000000000000000", "9000000000000000000")).toBe("+11.1%");
    // 2^53=9007199254740992 附近：Number 化会失真，定点计算保持精确
    expect(periodChangePercent("18014398509481984", "9007199254740992")).toBe("+100.0%");
  });

  it("十分位四舍五入（半入）", () => {
    // +0.05% → 0.1%；+0.04% → 0.0%（上期 1 亿，delta 5 万/4 万）
    expect(periodChangePercent("100050000", "100000000")).toBe("+0.1%");
    expect(periodChangePercent("100040000", "100000000")).toBe("+0.0%");
  });

  it("负增长带负号、无 + 号", () => {
    expect(periodChangePercent("8000000", "10000000")).toBe("-20.0%");
  });

  it("上期为 0、负值或非法输入返回 null", () => {
    expect(periodChangePercent("100", "0")).toBeNull();
    expect(periodChangePercent("100", "0.00000000")).toBeNull();
    expect(periodChangePercent("100", "-5")).toBeNull();
    expect(periodChangePercent("abc", "100")).toBeNull();
    expect(periodChangePercent("100", "")).toBeNull();
    expect(periodChangePercent("100abc", "100")).toBeNull();
    expect(periodChangePercent("1.2.3", "100")).toBeNull();
  });

  it("显式正号与 8 位小数截断契约（后端金额固定 8 位小数）", () => {
    expect(periodChangePercent("+150", "100")).toBe("+50.0%");
    // 第 9 位小数在定点化时截断：1.000000009 → 1.00000000，差值为 0。
    expect(periodChangePercent("1.000000009", "1")).toBe("0.0%");
    expect(periodChangePercent("50", "100")).toBe("-50.0%");
  });

  it("上一期相等时输出 0.0%（无 + 号）", () => {
    expect(periodChangePercent("10000000", "10000000")).toBe("0.0%");
  });
});

describe("tokenPeriodComparable / previousTokenQualityNote（口径防回归）", () => {
  it("任一期 UNKNOWN 或 unknownCount>0 即不可比", () => {
    expect(tokenPeriodComparable(
      { usageQuality: "EXACT", unknownCount: 0 },
      { usageQuality: "UNKNOWN", unknownCount: 2 },
    )).toBe(false);
    expect(tokenPeriodComparable(
      { usageQuality: "EXACT", unknownCount: 1 },
      { usageQuality: "EXACT", unknownCount: 0 },
    )).toBe(false);
    expect(tokenPeriodComparable(
      { usageQuality: "EXACT", unknownCount: 0 },
      { usageQuality: "ESTIMATED", unknownCount: 0 },
    )).toBe(true);
  });

  it("同期质量说明文案", () => {
    expect(previousTokenQualityNote({ usageQuality: "UNKNOWN", unknownCount: 1 })).toBe("上月同期含未知用量");
    expect(previousTokenQualityNote({ usageQuality: "ESTIMATED", unknownCount: 0 })).toBe("上月同期含估算用量");
    expect(previousTokenQualityNote({ usageQuality: "EXACT", unknownCount: 0 })).toBeNull();
    expect(previousTokenQualityNote({ usageQuality: "UNKNOWN", unknownCount: 0 })).toBe("上月同期含未知用量");
    expect(tokenPeriodComparable(
      { usageQuality: "UNKNOWN", unknownCount: 0 },
      { usageQuality: "EXACT", unknownCount: 0 },
    )).toBe(false);
  });
});

// ---------- V14-C4 G01/G02：buildOverviewCards 双期可比性与费用完整性业务规则 ----------

function cardsFixture(): StandardHomeSummary {
  const window = {
    rangeStart: "2026-08-31T16:00:00.000Z",
    rangeEndExclusive: "2026-09-10T06:00:00.000Z",
    truncated: false,
  };
  return {
    asOf: "2026-09-10T06:00:00.000Z",
    month: "2026-09",
    tokenUsage: {
      rangeStart: "2026-08-31T16:00:00.000Z",
      rangeEndExclusive: "2026-09-30T16:00:00.000Z",
      current: {
        totalTokens: "1000000000", inputTokens: "600000000", outputTokens: "400000000",
        usageQuality: "EXACT", unknownCount: 0,
      },
      previous: { totalTokens: "833000000", usageQuality: "EXACT", unknownCount: 0, window },
    },
    monthlyCost: {
      month: "2026-09",
      billStatus: "DRAFT",
      current: {
        totalSpends: [{ currency: "CNY", amount: "12800.00000000" }],
        apiSpends: [{ currency: "CNY", amount: "9800.00000000" }],
        packageCosts: [{ currency: "CNY", amount: "3000.00000000" }],
        incompleteReason: null,
      },
      previous: {
        totalSpends: [{ currency: "CNY", amount: "11851.85000000" }],
        incompleteReason: null,
        basis: "BALANCE_BRIDGE",
        window,
      },
    },
    activeEmployees: {
      timezone: "Asia/Shanghai",
      rangeStart: "2026-08-31T16:00:00.000Z",
      rangeEndExclusive: "2026-09-30T16:00:00.000Z",
      current: 28,
      previous: { count: 25, window },
    },
    activeProjects: {
      rangeStart: "2026-08-31T16:00:00.000Z",
      rangeEndExclusive: "2026-09-30T16:00:00.000Z",
      current: 6,
      previous: { count: 5, window },
    },
    resources: {
      providerCount: 1, resourceCount: 1, attentionProviderCount: 0,
      updatedAt: null, providers: [],
    },
  };
}

// ---------- R04 mutant 127/132 回归：金额同期比较的币种一致性与单币守卫 ----------
describe("moneyChangePercent（币种守卫）", () => {
  it("币种不一致（当期 CNY 200 / 同期 USD 100）：返回 null，禁止跨币种百分比", () => {
    expect(moneyChangePercent(
      [{ currency: "CNY", amount: "200.00000000" }],
      [{ currency: "USD", amount: "100.00000000" }],
    )).toBeNull();
  });

  it("当期多币种（CNY 200 + USD 50）对同期单币：返回 null", () => {
    expect(moneyChangePercent(
      [
        { currency: "CNY", amount: "200.00000000" },
        { currency: "USD", amount: "50.00000000" },
      ],
      [{ currency: "CNY", amount: "100.00000000" }],
    )).toBeNull();
  });

  it("同期多币种对当期单币：返回 null", () => {
    expect(moneyChangePercent(
      [{ currency: "CNY", amount: "200.00000000" }],
      [
        { currency: "CNY", amount: "100.00000000" },
        { currency: "USD", amount: "50.00000000" },
      ],
    )).toBeNull();
  });

  it("同币种单币：正常输出百分比（守卫不误杀）", () => {
    expect(moneyChangePercent(
      [{ currency: "CNY", amount: "200.00000000" }],
      [{ currency: "CNY", amount: "100.00000000" }],
    )).toBe("+100.0%");
  });
});

describe("tokenQualityLabel（质量文案三态）", () => {
  it("EXACT/ESTIMATED/UNKNOWN 与 unknownCount>0 各自输出", () => {
    expect(tokenQualityLabel("EXACT", 0)).toBe("上游实报");
    expect(tokenQualityLabel("ESTIMATED", 0)).toBe("含估算用量");
    expect(tokenQualityLabel("UNKNOWN", 0)).toBe("部分用量未知，合计不完整");
    expect(tokenQualityLabel("EXACT", 2)).toBe("部分用量未知，合计不完整");
  });
});

describe("costGapLabel（缺口码映射全表）", () => {
  it("六个缺口码逐一映射，分隔符为顿号", () => {
    expect(costGapLabel("API_USAGE_COST_UNKNOWN:1")).toBe("存在未知 API 费用");
    expect(costGapLabel("API_COST_CURRENCY_MISSING:1")).toBe("有费用缺少币种");
    expect(costGapLabel("API_COST_CURRENCY_CONFLICT:1")).toBe("有费用币种与计价规则冲突");
    expect(costGapLabel("OPENING_BALANCE_MISSING:1")).toBe("有账户缺少期初余额");
    expect(costGapLabel("SUBSCRIPTION_PERIOD_MISSING:1")).toBe("有套餐用量缺少订阅周期");
    expect(costGapLabel("CASH_PAID_CNY_MISSING:1")).toBe("有充值或套餐采购未登记现金支出");
    expect(costGapLabel("API_USAGE_COST_UNKNOWN:1、OPENING_BALANCE_MISSING:1")).toBe(
      "存在未知 API 费用、有账户缺少期初余额",
    );
  });
});

describe("buildOverviewCards（双期可比性与费用完整性）", () => {
  it("双期完整：输出百分比、同期值与桥接口径提示", () => {
    const cards = buildOverviewCards(cardsFixture());
    expect(cards.token.delta).toBe("较上月同期 +20.0%");
    expect(cards.token.footnote).toBe("上月同期 8.33 亿 Token");
    expect(cards.cost.primary).toBe("¥12,800.00");
    expect(cards.cost.delta).toBe("较上月同期 +8.0%");
    expect(cards.cost.footnote).toBe("上月同期 ¥11,851.85");
    expect(cards.cost.hints).toContain("同期按余额桥接口径聚合");
    expect(cards.cost.hints).not.toContain("同期按资金账本口径聚合");
    expect(cards.token.hint).toBe("输入 + 输出合计，缓存不重复累加 · 上游实报");
    expect(cards.cost.emptyText).toBeNull();
    expect(cards.cost.additional).toEqual([]);
  });

  it("本期含未知记录：禁百分比并说明分母不完整", () => {
    const data = cardsFixture();
    data.tokenUsage.current.unknownCount = 1;
    const cards = buildOverviewCards(data);
    expect(cards.token.delta).toBe("本期或同期用量不完整，不计算百分比");
  });

  it("同期质量未知：脚注注明且禁百分比", () => {
    const data = cardsFixture();
    data.tokenUsage.previous.usageQuality = "UNKNOWN";
    data.tokenUsage.previous.unknownCount = 3;
    const cards = buildOverviewCards(data);
    expect(cards.token.delta).toBe("本期或同期用量不完整，不计算百分比");
    expect(cards.token.footnote).toContain("上月同期含未知用量");
  });

  it("本期费用缺口：保留已知金额并给出缺口说明与口径提示", () => {
    const data = cardsFixture();
    data.monthlyCost.current.incompleteReason = "API_USAGE_COST_UNKNOWN:2";
    const cards = buildOverviewCards(data);
    expect(cards.cost.delta).toBe("金额存在缺口，不计算百分比");
    expect(cards.cost.hints[0]).toBe("金额不完整：存在未知 API 费用，已展示已知部分");
    expect(cards.cost.primary).toBe("¥12,800.00");
  });

  it("同期费用缺口：禁百分比且脚注透出缺口", () => {
    const data = cardsFixture();
    data.monthlyCost.previous!.incompleteReason = "CASH_PAID_CNY_MISSING:1";
    const cards = buildOverviewCards(data);
    expect(cards.cost.delta).toBe("金额存在缺口，不计算百分比");
    expect(cards.cost.footnote).toContain("有充值或套餐采购未登记现金支出");
  });

  it("资金读模型口径：提示切换", () => {
    const data = cardsFixture();
    data.monthlyCost.previous = {
      ...data.monthlyCost.previous!,
      basis: "FINANCE_READ_MODEL",
    };
    const cards = buildOverviewCards(data);
    expect(cards.cost.hints).toContain("同期按资金账本口径聚合");
  });

  it("多币种：主币种加其余币种分行，禁百分比", () => {
    const data = cardsFixture();
    data.monthlyCost.current.totalSpends = [
      { currency: "CNY", amount: "1200.00000000" },
      { currency: "USD", amount: "30.50000000" },
    ];
    data.monthlyCost.previous = null;
    const cards = buildOverviewCards(data);
    expect(cards.cost.primary).toBe("¥1,200.00");
    expect(cards.cost.additional).toEqual(["USD 30.50"]);
    expect(cards.cost.delta).toBe("上月同期暂无可比数据，不计算百分比");
    expect(cards.cost.footnote).toBe("上月同期 暂无可比数据");
  });

  it("Token 质量文案三态与上期为 0 表述", () => {
    const base = cardsFixture();
    expect(buildOverviewCards(base).token.hint).toContain("上游实报");
    const estimated = cardsFixture();
    estimated.tokenUsage.current.usageQuality = "ESTIMATED";
    expect(buildOverviewCards(estimated).token.hint).toContain("含估算用量");
    const unknown = cardsFixture();
    unknown.tokenUsage.current.usageQuality = "UNKNOWN";
    expect(buildOverviewCards(unknown).token.hint).toContain("部分用量未知，合计不完整");
    const zeroPrevious = cardsFixture();
    zeroPrevious.tokenUsage.previous.totalTokens = "0";
    expect(buildOverviewCards(zeroPrevious).token.delta).toBe("上月同期为 0 或用量未知，不计算百分比");
  });

  it("R04 #155/158：不可比且上期为 0 时仍表述为上期为 0（非不完整）", () => {
    const data = cardsFixture();
    data.tokenUsage.current.unknownCount = 1;
    data.tokenUsage.previous.totalTokens = "0";
    const cards = buildOverviewCards(data);
    expect(cards.token.delta).toBe("上月同期为 0 或用量未知，不计算百分比");
  });

  it("R04 #155/157/158：可比且上期为 0 时表述为上期为 0（非不完整）", () => {
    const data = cardsFixture();
    data.tokenUsage.previous.totalTokens = "0";
    const cards = buildOverviewCards(data);
    expect(cards.token.delta).toBe("上月同期为 0 或用量未知，不计算百分比");
  });

  it("R04 #188：非纯零小数（0.50）不判为全零（当期多币种场景）", () => {
    const data = cardsFixture();
    data.monthlyCost.current.totalSpends = [
      { currency: "CNY", amount: "200.00000000" },
      { currency: "USD", amount: "50.00000000" },
    ];
    data.monthlyCost.previous = {
      ...data.monthlyCost.previous!,
      totalSpends: [{ currency: "CNY", amount: "0.50" }],
    };
    const cards = buildOverviewCards(data);
    expect(cards.cost.delta).toBe("上月同期无可比金额或多币种，不计算百分比");
  });

  it("R04 #189：双零整数（00）判为全零", () => {
    const data = cardsFixture();
    data.monthlyCost.previous = {
      ...data.monthlyCost.previous!,
      totalSpends: [{ currency: "CNY", amount: "00" }],
    };
    const cards = buildOverviewCards(data);
    expect(cards.cost.delta).toBe("上月同期为 0，不计算百分比");
  });

  it("R04 #191：两位小数零（0.00）判为全零", () => {
    const data = cardsFixture();
    data.monthlyCost.previous = {
      ...data.monthlyCost.previous!,
      totalSpends: [{ currency: "CNY", amount: "0.00" }],
    };
    const cards = buildOverviewCards(data);
    expect(cards.cost.delta).toBe("上月同期为 0，不计算百分比");
  });

  it("上期零值格式全覆盖（0 / 0.0 / 0.00000000）仍判为全零", () => {
    const data = cardsFixture();
    data.monthlyCost.previous = {
      ...data.monthlyCost.previous!,
      totalSpends: [
        { currency: "CNY", amount: "0" },
        { currency: "USD", amount: "0.0" },
        { currency: "JPY", amount: "0.00000000" },
      ],
    };
    const cards = buildOverviewCards(data);
    expect(cards.cost.delta).toBe("上月同期为 0，不计算百分比");
  });

  it("上期混合零值与非零值：不是全零，按无可比金额处理", () => {
    const data = cardsFixture();
    data.monthlyCost.previous = {
      ...data.monthlyCost.previous!,
      totalSpends: [
        { currency: "CNY", amount: "0" },
        { currency: "USD", amount: "100.00000000" },
      ],
    };
    const cards = buildOverviewCards(data);
    expect(cards.cost.delta).toBe("上月同期无可比金额或多币种，不计算百分比");
  });

  it("上期金额全为 0（多币种）：上月同期为 0，脚注保留零值", () => {
    const data = cardsFixture();
    data.monthlyCost.previous = {
      ...data.monthlyCost.previous!,
      totalSpends: [
        { currency: "CNY", amount: "0" },
        { currency: "USD", amount: "0.0" },
      ],
    };
    const cards = buildOverviewCards(data);
    expect(cards.cost.delta).toBe("上月同期为 0，不计算百分比");
    expect(cards.cost.footnote).toContain("¥0.00 / USD 0.00");
  });

  it("上期多币种非零：无可比金额或多币种表述", () => {
    const data = cardsFixture();
    data.monthlyCost.previous = {
      ...data.monthlyCost.previous!,
      totalSpends: [
        { currency: "CNY", amount: "100.00000000" },
        { currency: "USD", amount: "20.00000000" },
      ],
    };
    const cards = buildOverviewCards(data);
    expect(cards.cost.delta).toBe("上月同期无可比金额或多币种，不计算百分比");
  });

  it("上期存在但无可比金额且无原因：不可完整计算表述", () => {
    const data = cardsFixture();
    data.monthlyCost.previous = {
      totalSpends: [], incompleteReason: null, basis: "BALANCE_BRIDGE",
      window: data.monthlyCost.previous!.window,
    };
    const cards = buildOverviewCards(data);
    expect(cards.cost.footnote).toBe("上月同期 不可完整计算");
    expect(cards.cost.delta).toBe("上月同期无可比金额或多币种，不计算百分比");
  });

  it("本期无可计算金额：emptyText 回退到缺口原因或默认文案", () => {
    const noReason = cardsFixture();
    noReason.monthlyCost.current = {
      totalSpends: [], apiSpends: [], packageCosts: [], incompleteReason: null,
    };
    noReason.monthlyCost.previous = null;
    const cardsNoReason = buildOverviewCards(noReason);
    expect(cardsNoReason.cost.emptyText).toBe("暂无可计算费用");
    expect(cardsNoReason.cost.hints).toContain("经营账单口径；多币种分别展示，不换汇");

    const withReason = cardsFixture();
    withReason.monthlyCost.current = {
      totalSpends: [], apiSpends: [], packageCosts: [],
      incompleteReason: "OPERATING_SNAPSHOT_MISSING",
    };
    withReason.monthlyCost.previous = null;
    const cardsWithReason = buildOverviewCards(withReason);
    expect(cardsWithReason.cost.emptyText).toBe("OPERATING_SNAPSHOT_MISSING");
    expect(cardsWithReason.cost.delta).toBe("金额存在缺口，不计算百分比");
  });

  it("缺口码映射：未登记现金支出与未知费用", () => {
    expect(costGapLabel("API_USAGE_COST_UNKNOWN:2")).toContain("存在未知 API 费用");
    expect(costGapLabel("CASH_PAID_CNY_MISSING:1、OPENING_BALANCE_MISSING:1"))
      .toContain("有账户缺少期初余额");
    expect(costGapLabel("UNKNOWN_NEW_CODE")).toBe("UNKNOWN_NEW_CODE");
  });
});
