import { createContext, useContext, type ReactNode } from "react";
import type { FeatureFlags } from "./api/types";

export const DISABLED_FEATURE_FLAGS: FeatureFlags = {
  FEATURE_DIRECTORY_IMPORT: false,
  FEATURE_USAGE_OVERVIEW_V2: false,
  FEATURE_DEPARTMENT_COST: false,
  FEATURE_RESOURCE_UTILIZATION_V2: false,
  FEATURE_PROCUREMENT_REVIEW: false,
};

const TEST_FEATURE_FLAGS: FeatureFlags = {
  FEATURE_DIRECTORY_IMPORT: true,
  FEATURE_USAGE_OVERVIEW_V2: true,
  FEATURE_DEPARTMENT_COST: true,
  FEATURE_RESOURCE_UTILIZATION_V2: true,
  FEATURE_PROCUREMENT_REVIEW: true,
};

/** 测试环境默认开启；开发、试点与生产缺少服务端值时一律失败关闭。 */
export const DEFAULT_FEATURE_FLAGS = import.meta.env.MODE === "test"
  ? TEST_FEATURE_FLAGS
  : DISABLED_FEATURE_FLAGS;

const FeatureFlagContext = createContext<FeatureFlags>(DEFAULT_FEATURE_FLAGS);

export function FeatureFlagsProvider({
  value,
  children,
}: {
  value: FeatureFlags;
  children: ReactNode;
}) {
  return <FeatureFlagContext.Provider value={value}>{children}</FeatureFlagContext.Provider>;
}

export function useFeatureFlags(): FeatureFlags {
  return useContext(FeatureFlagContext);
}
