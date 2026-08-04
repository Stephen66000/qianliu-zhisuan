/** POOL-029：员工模型授权集合与发布预览的纯规则。 */

export interface PermissionKeyInput {
  proposed: string[];
  before: string[];
  after: string[];
  previousRule: string[];
}

export interface PermissionKeyChanges {
  added: string[];
  retained: string[];
  removed: string[];
}

export function mergeDeclaredModelIds(manualIds: string[], managedIds: string[]): string[] {
  return [...new Set([...manualIds, ...managedIds])].sort();
}

/**
 * 规则发布预览比较的是发布前后最终权限，而不是只比较同一 rule_id 的两个版本。
 * previousRule 仅用于定位“本次规则真正撤销”的旧目标；被手工或其他规则保留时不算撤销。
 */
export function classifyPermissionKeys(input: PermissionKeyInput): PermissionKeyChanges {
  const before = new Set(input.before);
  const after = new Set(input.after);
  const proposed = [...new Set(input.proposed)].sort();
  const previousRule = [...new Set(input.previousRule)].sort();
  return {
    added: proposed.filter((key) => !before.has(key)),
    retained: proposed.filter((key) => before.has(key)),
    removed: previousRule.filter((key) => !after.has(key)),
  };
}
