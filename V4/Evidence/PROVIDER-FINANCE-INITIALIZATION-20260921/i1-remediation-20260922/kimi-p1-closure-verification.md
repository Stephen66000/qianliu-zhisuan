# kimi 修复轮 6 项 P1 代码级关闭核验（复审方独立核验）

> 归属：本文件是本候选 I1 复核「继承代码核验」专节的证据底稿，同时归档到 kimi 候选证据目录，
> 视同其 6 项 P1 的独立核验记录。
> **独立性声明**：核验方为本候选的复审方，不是 kimi 的实现方；核验依据是提交 `5160002`
> 的代码事实与其自带回归测试的真实断言，不采信 commit message 或交付报告的自述结论。
> **核验时点**：kimi 提交 `5160002bdd0c4c6a4612fcb7060f45f9d4390cc2`（本候选 rebase 后的基线）。

## 0. 范围

- 本次仅核验 **6 项阻塞级 P1**。
- kimi 侧 **13 项 P2 不在本次关闭范围内**（其中 kimi 在其 `3ac09ff` 中自述闭环 10 项，
  该轮提交未纳入本候选基线，也未经过任何审核覆盖）。
- 本次核验**不构成**对 kimi 候选的 GO 结论，只回答一个问题：
  「本候选继承的这段代码，是否已不处于原审核认定的 6 项 P1 失败态」。

## 1. 逐项核验

### P1-1 同步面板：探针失败模型被静默隐藏 / READY=0 误报「均已接入」

| 项 | 内容 |
|---|---|
| 修复位置 | `apps/web/src/components/resources/ResourceModelDiscovery.tsx:60`、`:529`；`ResourceModelDiscoveryShared.tsx:51` |
| 代码事实 | `const failureCount = props.discovery?.summary?.credential_failed ...`（失败模型进入独立计数与列表）；`Shared.tsx:51` 摘要类型显式包含 `credential_failed: number`；`ResourceModelDiscovery.tsx:529` 注明「单独列出并展示原因；零可选时不得误报"均已接入"」 |
| 回归测试 | `ResourceModelDiscovery.sync.test.tsx:165`「审核修复（P1）：探针失败模型不再被静默隐藏——列出并给出原因」；`:207`「审核修复（P1）：全部模型探针失败（READY=0）时明示配置问题，不误报均已接入」 |
| 真实断言 | 存在（`expect(...)` 针对失败模型的展示与 README=0 时不再出现「均已接入」文案） |
| 结论 | **关闭** |

### P1-2 证据身份门禁自锁（REMOVED 快照行）

| 项 | 内容 |
|---|---|
| 修复位置 | `apps/control-api/src/providers/probe-evidence.ts:125`、`:132` |
| 代码事实 | `.filter((item) => item.availability_status !== "REMOVED")`；注释明确「快照为官方下架保留的 REMOVED 行不参与（否则下架当次同步的新鲜证据会被判 STALE）」 |
| 回归测试 | `apps/control-api/src/providers/probe-evidence.test.ts:28`「currentAvailableModelIds 剔除 REMOVED 行」；`:36`「官方下架模型（REMOVED 行保留在快照）不使新鲜证据被判 STALE」；`:57`（对照组，不过滤仍判 STALE） |
| 真实断言 | 存在，且含正向 + 对照双向断言（`expect(identity).toEqual({ valid: true, reason: null })` / `{ valid: false, reason: "MODEL_SET_MISMATCH" }`） |
| 结论 | **关闭** |

### P1-3 端点歧义误报为上游 500（证据保真）

| 项 | 内容 |
|---|---|
| 修复位置 | `packages/provider-adapters/src/openai-compatible-caller.ts:137`、`:143-144`、`:152-153` |
| 代码事实 | 端点歧义时返回 `status = 0` + `failureLayer: "CLIENT"` + `unifiedAvailabilitySignal: "CONFIGURATION_ERROR"`，注释「status=0 + failureLayer=CLIENT + 预置 CONFIGURATION_ERROR 信号」，不再合成上游 500 |
| 回归测试 | `packages/provider-adapters/src/__tests__/openai-compatible-caller.test.ts:1922`「审核修复（P1）：端点歧义是本侧配置错误——不合成上游 500，返回 CONFIGURATION_ERROR 信号」 |
| 真实断言 | 存在，关键断言为 `throw new Error("端点歧义时不应发起任何上游请求")`（fetch 桩）＋ 返回值匹配 |
| 结论 | **关闭** |

### P1-4 额度同步 worker 漏改（大写厂商 code 被整体跳过）

| 项 | 内容 |
|---|---|
| 修复位置 | `apps/worker/src/coding-plan-quota/runner.ts:21`、`:49`、`:51` |
| 代码事实 | `const code = canonicalProviderCode(rawCode);`，先规范化再匹配额度同步支持的厂商 |
| 回归测试 | `apps/worker/src/coding-plan-quota/runner.test.ts:260`「审核修复（P1）：生产大写厂商 code（Kimi）不再被额度同步整体跳过」（夹具 `code: "Kimi"`） |
| 真实断言 | 存在（针对同步是否执行的 DB 断言） |
| 结论 | **关闭** |

### P1-5 真实验证严格比较厂商 code（大写 Zhipu 丢失 glm-5.3 专属分支）

| 项 | 内容 |
|---|---|
| 修复位置 | `apps/control-api/src/providers/model-discovery-routes.ts:375`、`:384-385` |
| 代码事实 | `const isGlm53 = validationProviderCode === "zhipu" && req.params.upstreamModel === "glm-5.3";`，其中 `validationProviderCode = canonicalProviderCode(target.provider_code)`；`:384` `reasoningEffort: isGlm53 ? "max" : undefined`、`:385` `runToolCheck: isGlm53` |
| 回归测试 | `apps/control-api/src/__tests-integration__/pool027-provider-model-discovery.test.ts:653`「审核修复（P1）：大写厂商 code（Zhipu）不丢失 glm-5.3 专属真实验证」（夹具 `code: "Zhipu"`） |
| 真实断言 | 存在（集成断言，含 glm-5.3 专属参数是否生效） |
| 结论 | **关闭** |

### P1-6 体量门禁 3 处违例

| 项 | 内容 |
|---|---|
| 修复位置 | 门禁项，无单点代码位置 |
| 客观核验 | 在 `5160002` 时点按交付门禁脚本实测：`node scripts/check-source-size.mjs` → **pass**（全部文件 ≤400 或 ≤登记基线）；本案 3 个文件实测 `model-discovery-routes.ts` 392、`ResourceModelDiscovery.tsx` 687（基线 723）、`model-discovery.ts` 408（基线 484） |
| 结论 | **关闭**（机械门禁，客观可复现，不依赖自述） |

## 2. 核验结论

| 项 | 独立核验结果 |
|---|---|
| P1-1 同步面板零可选误导 | 关闭 |
| P1-2 READY 证据门禁自锁 | 关闭 |
| P1-3 端点歧义误报上游 500 | 关闭 |
| P1-4 额度同步 worker 漏改 | 关闭 |
| P1-5 真实验证严格比较厂商 code | 关闭 |
| P1-6 体量门禁 3 处违例 | 关闭（客观实测） |

- **6/6 关闭**，每项均有「代码位置 + 关键代码事实 + 对应回归测试（含真实断言）」三要素可查。
- 未采纳的自述内容：kimi 交付报告中的测试矩阵通过数字未由本方复跑；本方按 rebase 后的新 HEAD
  统一复跑本仓门禁（见本目录其余证据），不复跑 kimi 侧的独立分支。
- 遗留（不在本次关闭范围）：kimi 侧 13 项 P2；其中 10 项在 `3ac09ff` 自述闭环但**未经审核覆盖**，
  3 项仍未处置。若后续需要把 kimi 分支整体并入交付，须另行审核。
