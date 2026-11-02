/** Activation scope validation and required opening-account resolution (pure functions). */
import type { ActivationGap, NormalizedActivationCandidate } from "./provider-finance-activation.js";
import { money } from "./provider-finance-balance-components.js";
import {
  accountKey, compareStrings, gap,
  type ActivationProjectionInput, type ActivationScopeResourceInput,
  type ActivationScopeAccountInput, type FinanceFactRow,
} from "./provider-finance-activation-inputs.js";

/**
 * 草稿引用的资源必须落在激活范围内（跨企业或已删除资源失败关闭），
 * 且资源模式与期初时点必须匹配。
 */
export function collectScopeAndModeGaps(
  input: ActivationProjectionInput,
  resourcesById: Map<string, ActivationScopeResourceInput>,
  cutoverAt: string,
  gaps: ActivationGap[],
): void {
  const draftResourceIds = new Set<string>([
    ...input.draft.apiOpeningBalances.map((item) => item.resourceId),
    ...input.draft.historicalApiRecharges.map((item) => item.resourceId),
    ...input.draft.historicalApiCosts.map((item) => item.resourceId),
    ...input.draft.codingPlanPurchases.map((item) => item.resourceId),
    ...input.draft.codingPlanCarryovers.map((item) => item.resourceId),
    ...input.draft.legacyPurchaseResolutions.map((item) => item.resourceId),
  ]);
  for (const resourceId of [...draftResourceIds].sort(compareStrings)) {
    if (!resourcesById.has(resourceId)) {
      gaps.push(gap("UNKNOWN_RESOURCE", "SCOPE", "草稿引用的资源不在本企业激活范围内", { resourceId }));
    }
  }

  for (const opening of input.draft.apiOpeningBalances) {
    const resource = resourcesById.get(opening.resourceId);
    if (resource && resource.mode !== "API") {
      gaps.push(gap("RESOURCE_MODE_MISMATCH", "OPENING_BALANCE", "期初余额只能登记在 API 资源上",
        { resourceId: opening.resourceId, accountCurrency: opening.accountCurrency }));
    }
    if (opening.occurredAt !== cutoverAt) {
      gaps.push(gap("OPENING_TIME_MISMATCH", "OPENING_BALANCE", "期初时点固定为资金切换时点",
        { resourceId: opening.resourceId, accountCurrency: opening.accountCurrency,
          detail: opening.occurredAt }));
    }
  }
  for (const recharge of input.draft.historicalApiRecharges) {
    const resource = resourcesById.get(recharge.resourceId);
    if (resource && resource.mode !== "API") {
      gaps.push(gap("RESOURCE_MODE_MISMATCH", "RECHARGE", "历史 API 充值只能登记在 API 资源上",
        { resourceId: recharge.resourceId, accountCurrency: recharge.accountCurrency }));
    }
  }
  for (const cost of input.draft.historicalApiCosts) {
    const resource = resourcesById.get(cost.resourceId);
    if (resource && resource.mode !== "API") {
      gaps.push(gap("RESOURCE_MODE_MISMATCH", "USAGE", "历史 API 消耗只能登记在 API 资源上",
        { resourceId: cost.resourceId, accountCurrency: cost.accountCurrency }));
    }
  }
  for (const purchase of input.draft.codingPlanPurchases) {
    const resource = resourcesById.get(purchase.resourceId);
    if (resource && resource.mode !== "CODING_PLAN") {
      gaps.push(gap("RESOURCE_MODE_MISMATCH", "PURCHASE", "Coding Plan 购买只能登记在套餐资源上",
        { resourceId: purchase.resourceId }));
    }
  }
  for (const carryover of input.draft.codingPlanCarryovers) {
    const resource = resourcesById.get(carryover.resourceId);
    if (resource && resource.mode !== "CODING_PLAN") {
      gaps.push(gap("RESOURCE_MODE_MISMATCH", "PERIOD", "跨切换周期只能登记在套餐资源上",
        { resourceId: carryover.resourceId }));
    }
    // 管理员声明路径与旧快照路径同规则：周期必须真实跨过固定切换时点
    // （开始 < 切换且结束(排他) > 切换），只用于覆盖切换后用量。
    if (!(carryover.periodStart < cutoverAt && carryover.periodEndExclusive > cutoverAt)) {
      gaps.push(gap("CARRYOVER_NOT_CROSSING_CUTOVER", "PERIOD",
        "跨切换周期必须真实跨过资金切换时点", {
          resourceId: carryover.resourceId,
          detail: `${carryover.periodStart} .. ${carryover.periodEndExclusive}`,
        }));
    }
  }
  // 草稿内重叠检测：同资源的跨切换周期互相重叠会让覆盖它们的用量行产生
  // 归属歧义（PFH-03），无用量行时也会造成重复周期，一并失败关闭。
  const carryoversByResource = new Map<string, NormalizedActivationCandidate["codingPlanCarryovers"]>();
  for (const carryover of input.draft.codingPlanCarryovers) {
    const group = carryoversByResource.get(carryover.resourceId);
    if (group) group.push(carryover); else carryoversByResource.set(carryover.resourceId, [carryover]);
  }
  for (const resourceId of [...carryoversByResource.keys()].sort(compareStrings)) {
    const group = [...carryoversByResource.get(resourceId)!]
      .sort((left, right) => compareStrings(left.periodStart, right.periodStart)
        || compareStrings(left.periodEndExclusive, right.periodEndExclusive));
    for (let i = 1; i < group.length; i += 1) {
      const prev = group[i - 1]!;
      const curr = group[i]!;
      if (curr.periodStart < prev.periodEndExclusive) {
        gaps.push(gap("CARRYOVER_PERIOD_OVERLAP", "PERIOD",
          "同资源的跨切换周期在草稿中互相重叠", {
            resourceId,
            detail: `${prev.periodStart}..${prev.periodEndExclusive} vs `
              + `${curr.periodStart}..${curr.periodEndExclusive}`,
          }));
      }
    }
  }
}

interface OpeningResolution {
  scopeAccounts: Map<string, ActivationScopeAccountInput>;
  realOpenings: Map<string, FinanceFactRow>;
  draftOpenings: Map<string, { amount: string; description: string; evidenceRef: string }>;
}

/** 必要币种账户的期初余额必须且仅有一条（PFH-01）。 */
export function resolveOpeningAccounts(
  input: ActivationProjectionInput,
  resourcesById: Map<string, ActivationScopeResourceInput>,
  gaps: ActivationGap[],
): OpeningResolution {
  const realOpenings = new Map<string, FinanceFactRow>();
  for (const event of input.financeEvents) {
    if (event.eventType !== "API_OPENING_BALANCE") continue;
    realOpenings.set(accountKey(event.resourceId, event.currency), event);
  }
  const draftOpenings = new Map<string, { amount: string; description: string; evidenceRef: string }>();
  for (const opening of input.draft.apiOpeningBalances) {
    const key = accountKey(opening.resourceId, opening.accountCurrency);
    const previous = draftOpenings.get(key);
    if (previous) {
      // 同一账户出现两条草稿期初：若直接 `Map.set()` 会静默覆盖前一条，
      // 让管理员在无感知的情况下丢失一条期初登记。这里失败关闭，
      // 要求先去重再预检（PFH-01：期初余额必须且仅有一条）。
      gaps.push(gap("DUPLICATE_OPENING_BALANCE", "OPENING_BALANCE",
        "该账户在草稿中登记了多条期初余额，请先去重再提交预检", {
          resourceId: opening.resourceId, accountCurrency: opening.accountCurrency,
          detail: `first=${previous.amount} duplicate=${opening.accountAmount}`,
        }));
      continue;
    }
    draftOpenings.set(key, {
      amount: opening.accountAmount, description: opening.description, evidenceRef: opening.evidenceRef,
    });
  }
  for (const opening of input.draft.apiOpeningBalances) {
    const key = accountKey(opening.resourceId, opening.accountCurrency);
    const existing = realOpenings.get(key);
    if (existing && money(existing.accountAmount) !== money(opening.accountAmount)) {
      gaps.push(gap("DUPLICATE_OPENING_BALANCE", "OPENING_BALANCE",
        "该账户已存在金额不同的原始期初余额", {
          resourceId: opening.resourceId, accountCurrency: opening.accountCurrency,
          detail: `existing=${money(existing.accountAmount)} draft=${money(opening.accountAmount)}`,
        }));
    }
  }
  const scopeAccounts = new Map<string, ActivationScopeAccountInput>();
  for (const account of input.accounts) {
    scopeAccounts.set(accountKey(account.resourceId, account.currency), account);
  }
  for (const opening of input.draft.apiOpeningBalances) {
    const key = accountKey(opening.resourceId, opening.accountCurrency);
    if (!scopeAccounts.has(key)) {
      scopeAccounts.set(key, {
        resourceId: opening.resourceId, currency: opening.accountCurrency, sources: ["ADMIN_DECLARED"],
      });
    }
  }
  const apiResourceIds = [...resourcesById.values()]
    .filter((resource) => resource.mode === "API")
    .map((resource) => resource.resourceId).sort(compareStrings);
  for (const resourceId of apiResourceIds) {
    const accounts = [...scopeAccounts.values()]
      .filter((account) => account.resourceId === resourceId)
      .sort((left, right) => compareStrings(left.currency, right.currency));
    if (accounts.length === 0) {
      gaps.push(gap("REQUIRED_CURRENCY_UNRESOLVED", "OPENING_BALANCE",
        "该 API 资源无法推导必要币种，必须由管理员显式选择至少一个账户币种并说明理由",
        { resourceId }));
      continue;
    }
    for (const account of accounts) {
      const key = accountKey(resourceId, account.currency);
      if (realOpenings.has(key)) continue;
      const draftOpening = draftOpenings.get(key);
      if (!draftOpening) {
        gaps.push(gap("MISSING_OPENING_BALANCE", "OPENING_BALANCE", "必要币种账户缺少原始期初余额",
          { resourceId, accountCurrency: account.currency }));
        continue;
      }
      if (draftOpening.description.trim().length === 0 || draftOpening.evidenceRef.trim().length === 0) {
        gaps.push(gap("MISSING_OPENING_EVIDENCE", "OPENING_BALANCE", "期初余额必须填写说明与证据引用",
          { resourceId, accountCurrency: account.currency }));
      }
    }
  }
  return { scopeAccounts, realOpenings, draftOpenings };
}
