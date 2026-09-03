// @ts-check
// 仟流智算 ESLint flat config。工程规则 §7：禁止无理由 any、吞错、静默降级。
import tseslint from "@typescript-eslint/eslint-plugin";
import tsparser from "@typescript-eslint/parser";
import react from "eslint-plugin-react";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";

export default [
  {
    files: ["**/*.ts", "**/*.tsx"],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: 2023,
        sourceType: "module",
      },
      globals: {
        ...globals.node,
      },
    },
    plugins: {
      "@typescript-eslint": tseslint,
    },
    rules: {
      ...tseslint.configs.recommended.rules,
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/consistent-type-imports": "warn",
      "no-console": ["warn", { allow: ["warn", "error"] }],
      eqeqeq: ["error", "always"],
      complexity: ["error", 30],
    },
  },
  {
    files: ["apps/web/**/*.tsx", "apps/web/**/*.ts"],
    languageOptions: {
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
      globals: {
        ...globals.browser,
      },
    },
    plugins: {
      react,
      "react-hooks": reactHooks,
    },
    settings: {
      react: { version: "detect" },
    },
    rules: {
      ...react.configs.recommended.rules,
      // React 19 + jsx: react-jsx 不需要显式 import React
      "react/react-in-jsx-scope": "off",
      "react/prop-types": "off",
      // React Hooks 规则（W18 引入，防止 hook 依赖缺失/条件调用）
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
    },
  },
  {
    // CLI 脚本与 app 入口允许 console
    files: ["**/src/cli/**/*.ts", "apps/*/src/server.ts", "apps/*/src/main.ts"],
    rules: {
      "no-console": "off",
    },
  },
  {
    // 生产基线遗留复杂函数：只允许降复杂度，不允许继续增长。
    files: ["apps/control-api/src/read-models/routes.ts"],
    rules: { complexity: ["error", 35] },
  },
  {
    files: ["apps/web/src/pages/Principals.tsx"],
    rules: { complexity: ["error", 48] },
  },
  {
    files: ["apps/web/src/pages/QuotaRules.tsx"],
    rules: { complexity: ["error", 84] },
  },
  {
    files: ["apps/web/src/pages/RequestDrilldown.tsx"],
    rules: { complexity: ["error", 31] },
  },
  {
    files: ["apps/web/src/pages/Resources.tsx"],
    rules: { complexity: ["error", 59] },
  },
  {
    files: ["apps/web/src/pages/Usage.tsx"],
    rules: { complexity: ["error", 37] },
  },
  {
    files: ["packages/database/src/repositories/dashboard-repository.ts"],
    rules: { complexity: ["error", 31] },
  },
  {
    files: ["packages/database/src/repositories/dispatch-policy-repository.ts"],
    rules: { complexity: ["error", 32] },
  },
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/coverage/**",
      "**/*.config.js",
      "**/*.config.mjs",
      "参考/**",
      "_quarantine/**",
      "V3/PoC/**",
    ],
  },
];
