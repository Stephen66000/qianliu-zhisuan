/**
 * W18 主题状态（React 绑定层）—— 偏好三态 + 解析结果 + 系统监听。
 *
 * 防闪烁：index.html 的内联脚本已在挂载前完成首次 applyTheme；
 * 本模块负责用户切换后的应用与 system 模式下的动态跟随。
 */
import { useCallback, useEffect, useState } from "react";

import {
  applyTheme,
  loadThemePreference,
  persistThemePreference,
  resolveTheme,
  type ResolvedTheme,
  type ThemePreference,
} from "./theme";

export interface ThemeState {
  preference: ThemePreference;
  resolved: ResolvedTheme;
  setPreference: (next: ThemePreference) => void;
}

export function useTheme(): ThemeState {
  const [preference, setPreferenceState] = useState<ThemePreference>(() => loadThemePreference());
  const [resolved, setResolved] = useState<ResolvedTheme>(() => resolveTheme(loadThemePreference()));

  const setPreference = useCallback((next: ThemePreference) => {
    persistThemePreference(next);
    setPreferenceState(next);
    const nextResolved = resolveTheme(next);
    applyTheme(nextResolved);
    setResolved(nextResolved);
  }, []);

  // 仅 system 模式跟随系统主题变化；显式选择后不监听（规范 §4）。
  useEffect(() => {
    if (preference !== "system") {
      return;
    }
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = (event: MediaQueryListEvent) => {
      const nextResolved: ResolvedTheme = event.matches ? "dark" : "light";
      applyTheme(nextResolved);
      setResolved(nextResolved);
    };
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [preference]);

  return { preference, resolved, setPreference };
}
