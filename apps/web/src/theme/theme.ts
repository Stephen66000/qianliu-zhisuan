/**
 * W18 主题管理 —— 仟流 Web 产品视觉规范 §4（明暗主题机制）。
 *
 * 规则：
 *   - 三态：system / light / dark（不存布尔），新用户默认 system；
 *   - <html data-theme="light|dark"> + color-scheme 同步；
 *   - 偏好存 localStorage（键 ql-theme-preference，应用级唯一来源）；
 *   - 仅 system 时监听 prefers-color-scheme；用户显式选择后不被系统覆盖；
 *   - 挂载前防闪烁由 index.html 内联脚本完成（与这里的键名/取值保持一致）。
 */

export type ThemePreference = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

export const THEME_STORAGE_KEY = "ql-theme-preference";

function isThemePreference(value: string | null): value is ThemePreference {
  return value === "system" || value === "light" || value === "dark";
}

export function loadThemePreference(): ThemePreference {
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    return isThemePreference(stored) ? stored : "system";
  } catch {
    return "system";
  }
}

export function resolveTheme(preference: ThemePreference): ResolvedTheme {
  if (preference !== "system") {
    return preference;
  }
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function applyTheme(resolved: ResolvedTheme): void {
  document.documentElement.dataset.theme = resolved;
  document.documentElement.style.colorScheme = resolved;
}

export function persistThemePreference(preference: ThemePreference): void {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    // localStorage 不可用（隐私模式等）时降级为会话内生效，不阻塞使用。
  }
}
