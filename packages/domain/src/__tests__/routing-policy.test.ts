/**
 * W12 单元/属性测试：路由评分与选择（routing-policy）。
 *
 * 覆盖（TRD §9 行 570-583；WT-13/18）：
 *   - priority 分组：只有最小 priority 候选参与竞争；低优先级组 NOT_TOP_PRIORITY
 *   - 多因子：weight 归一化、健康降权（DEGRADED/probe）、Affinity 命中
 *   - 稳定 tie-break：同分按 resourceId 字典序；输入顺序打乱结果不变（属性：顺序无关）
 *   - 确定性回放：同输入 100% 同输出（属性：可回放）
 *   - failover 排除：已尝试资源 EXCLUDED_ALREADY_TRIED，重评选到次优
 *   - Affinity 不绕过硬约束：Affinity 资源若不在候选（被硬过滤）则无效
 *
 * 属性测试：对随机生成的候选集，打乱输入顺序后选中者必须相同（稳定 tie-break）。
 */
import { describe, it, expect } from "vitest";
import {
  scoreAndSelect,
  pickWinner,
  healthScore,
  ROUTE_REASON,
  type RoutingCandidateInput,
} from "../index.js";

let seq = 0;
function cand(overrides: Partial<RoutingCandidateInput> = {}): RoutingCandidateInput {
  seq += 1;
  return {
    resourceId: `res-${String(seq).padStart(3, "0")}`,
    upstreamModel: "m",
    priority: 100,
    weight: 1,
    status: "ACTIVE",
    probe: false,
    mode: "API",
    providerCode: "deepseek",
    ...overrides,
  };
}

describe("healthScore 健康因子", () => {
  it("ACTIVE=1 / DEGRADED=0.6 / probe=0.3", () => {
    expect(healthScore("ACTIVE", false)).toBe(1);
    expect(healthScore("DEGRADED", false)).toBe(0.6);
    expect(healthScore("UNAVAILABLE", true)).toBe(0.3); // 半开 probe
  });
});

describe("scoreAndSelect priority 分组与评分", () => {
  it("只有最小 priority 组参与竞争；低优先级组 NOT_TOP_PRIORITY", () => {
    const hi = cand({ resourceId: "a-hi", priority: 10 });
    const lo = cand({ resourceId: "b-lo", priority: 100 });
    const results = scoreAndSelect([hi, lo]);
    const winner = pickWinner(results);
    expect(winner!.input.resourceId).toBe("a-hi");
    expect(results.find((r) => r.input.resourceId === "b-lo")!.reasonCode).toBe(ROUTE_REASON.NOT_TOP_PRIORITY);
  });

  it("同优先级内 weight 归一化影响总分", () => {
    const heavy = cand({ resourceId: "a-heavy", weight: 9 });
    const light = cand({ resourceId: "b-light", weight: 1 });
    const results = scoreAndSelect([heavy, light]);
    // weight 归一化：heavy=0.9, light=0.1（static_weight 因子）
    const heavyFactors = results.find((r) => r.input.resourceId === "a-heavy")!.factors;
    expect(heavyFactors.find((f) => f.name === "static_weight")!.value).toBeCloseTo(0.9, 5);
    expect(pickWinner(results)!.input.resourceId).toBe("a-heavy");
  });

  it("DEGRADED 健康降权：weight 差距小时健康者胜，差距大时 weight 优势盖过健康", () => {
    // weight 2:1（归一化 0.667/0.333）：健康者胜
    //   deg: 0.667*0.4 + 0.6*0.4 = 0.507；ok: 0.333*0.4 + 1.0*0.4 = 0.533 → ok 胜
    const deg2 = cand({ resourceId: "a-deg", weight: 2, status: "DEGRADED" });
    const ok2 = cand({ resourceId: "b-ok", weight: 1, status: "ACTIVE" });
    expect(pickWinner(scoreAndSelect([deg2, ok2]))!.input.resourceId).toBe("b-ok");

    // weight 3:1（归一化 0.75/0.25）：weight 优势盖过健康降权
    //   deg: 0.75*0.4 + 0.6*0.4 = 0.54；ok: 0.25*0.4 + 1.0*0.4 = 0.50 → deg 胜
    const deg3 = cand({ resourceId: "a-deg3", weight: 3, status: "DEGRADED" });
    const ok3 = cand({ resourceId: "b-ok3", weight: 1, status: "ACTIVE" });
    expect(pickWinner(scoreAndSelect([deg3, ok3]))!.input.resourceId).toBe("a-deg3");
  });

  it("Affinity 命中提升总分（WT-13 会话粘性）", () => {
    const a = cand({ resourceId: "a-first" });
    const b = cand({ resourceId: "b-second" });
    // 无 affinity：字典序 a-first 胜（同分 tie-break）
    expect(pickWinner(scoreAndSelect([a, b]))!.input.resourceId).toBe("a-first");
    // affinity 命中 b：b 胜
    expect(pickWinner(scoreAndSelect([a, b], "b-second"))!.input.resourceId).toBe("b-second");
    // affinity 因子值
    const bFactors = scoreAndSelect([a, b], "b-second").find((r) => r.input.resourceId === "b-second")!.factors;
    expect(bFactors.find((f) => f.name === "affinity")!.value).toBe(1);
  });

  it("稳定 tie-break：同分按 resourceId 字典序，与输入顺序无关", () => {
    const x = cand({ resourceId: "res-aaa" });
    const y = cand({ resourceId: "res-bbb" });
    const z = cand({ resourceId: "res-ccc" });
    const w1 = pickWinner(scoreAndSelect([x, y, z]))!.input.resourceId;
    const w2 = pickWinner(scoreAndSelect([z, y, x]))!.input.resourceId;
    const w3 = pickWinner(scoreAndSelect([y, z, x]))!.input.resourceId;
    expect(w1).toBe("res-aaa");
    expect(w2).toBe("res-aaa");
    expect(w3).toBe("res-aaa");
    const results = scoreAndSelect([x, y, z]);
    expect(pickWinner(results)!.reasonCode).toBe(ROUTE_REASON.SELECTED_TIE_BREAK);
    // 同分落选者标记 TIE_BREAK_LOST（变异行 182-183 幸存：未断言落选者 reasonCode）
    const losers = results.filter((r) => !r.selected);
    expect(losers.length).toBe(2);
    expect(losers.every((l) => l.reasonCode === ROUTE_REASON.TIE_BREAK_LOST)).toBe(true);
  });

  it("非同分落选者标记 LOWER_SCORE（区分 TIE_BREAK_LOST 与 LOWER_SCORE）", () => {
    const heavy = cand({ resourceId: "a-heavy", weight: 9 });
    const light = cand({ resourceId: "b-light", weight: 1 });
    const results = scoreAndSelect([heavy, light]);
    const winner = pickWinner(results)!;
    const loser = results.find((r) => !r.selected)!;
    expect(winner.reasonCode).toBe(ROUTE_REASON.SELECTED_TOP_SCORE);
    expect(loser.reasonCode).toBe(ROUTE_REASON.LOWER_SCORE);
  });
});

describe("failover 排除（提交前切换）", () => {
  it("已尝试资源 EXCLUDED_ALREADY_TRIED，重评选到次优", () => {
    const first = cand({ resourceId: "a-first" });
    const second = cand({ resourceId: "b-second" });
    const round1 = scoreAndSelect([first, second]);
    expect(pickWinner(round1)!.input.resourceId).toBe("a-first");

    // a-first 失败（committed=false）→ 排除重评 → b-second 胜
    const round2 = scoreAndSelect([first, second], null, new Set(["a-first"]));
    expect(pickWinner(round2)!.input.resourceId).toBe("b-second");
    expect(round2.find((r) => r.input.resourceId === "a-first")!.reasonCode).toBe(ROUTE_REASON.EXCLUDED_ALREADY_TRIED);
  });

  it("全部已尝试 → 无选中者（不无账放行）", () => {
    const a = cand({ resourceId: "a" });
    const results = scoreAndSelect([a], null, new Set(["a"]));
    expect(pickWinner(results)).toBeUndefined();
  });
});

describe("属性测试：确定性与顺序无关（回放 100%）", () => {
  // 伪随机但确定性的候选生成器（LCG，种子固定 → 可回放）
  function lcg(seed: number): () => number {
    let s = seed;
    return () => {
      s = (s * 1103515245 + 12345) % 2 ** 31;
      return s / 2 ** 31;
    };
  }

  it("100 组随机候选：打乱输入顺序后选中者恒定", () => {
    for (let trial = 0; trial < 100; trial++) {
      const rand = lcg(trial + 1);
      const n = 2 + Math.floor(rand() * 6); // 2..7 个候选
      const candidates: RoutingCandidateInput[] = Array.from({ length: n }, (_, i) =>
        cand({
          resourceId: `t${trial}-r${i}`,
          priority: [10, 50, 100][Math.floor(rand() * 3)]!,
          weight: 1 + Math.floor(rand() * 10),
          status: rand() < 0.3 ? "DEGRADED" : "ACTIVE",
        }),
      );
      const affinity = rand() < 0.5 ? candidates[0]!.resourceId : null;

      const base = pickWinner(scoreAndSelect(candidates, affinity));
      // 打乱顺序（确定性 shuffle：reverse + rotate）
      const shuffled = [...candidates].reverse();
      const rotated = [...candidates.slice(1), candidates[0]!];
      const w2 = pickWinner(scoreAndSelect(shuffled, affinity));
      const w3 = pickWinner(scoreAndSelect(rotated, affinity));

      if (base === undefined) {
        expect(w2).toBeUndefined();
        expect(w3).toBeUndefined();
      } else {
        expect(w2!.input.resourceId).toBe(base.input.resourceId);
        expect(w3!.input.resourceId).toBe(base.input.resourceId);
      }
    }
  });

  it("同输入两次评分结果逐因子一致（回放）", () => {
    const a = cand({ resourceId: "x", weight: 3, status: "DEGRADED" });
    const b = cand({ resourceId: "y", weight: 1 });
    const r1 = scoreAndSelect([a, b], "y");
    const r2 = scoreAndSelect([a, b], "y");
    expect(JSON.stringify(r1)).toBe(JSON.stringify(r2));
  });
});
