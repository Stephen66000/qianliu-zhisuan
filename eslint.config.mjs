// @ts-check
// 仟流智算 ESLint flat config。工程规则 §7：禁止无理由 any、吞错、静默降级。
import { readFileSync } from "node:fs";

import tseslint from "@typescript-eslint/eslint-plugin";
import tsparser from "@typescript-eslint/parser";
import react from "eslint-plugin-react";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";

/**
 * 视觉规范拦截用的选择器。类名可能写在普通字符串（含 JSX 属性）或模板字符串里，两处都查。
 * 颜色类前缀覆盖所有接受颜色的工具类，包括单边边框（border-t-*）、ring-offset、shadow 等。
 * 注意：esquery 的正则字面量里不能出现 "/"，需要斜杠时写 \x2F。
 */
const COLOR_UTILITIES =
  "bg|text|border(?:-[xytrblse])?|ring(?:-offset)?|outline|divide|fill|stroke|from|via|to|placeholder|shadow|accent|caret|decoration";
const TAILWIND_PALETTE =
  "slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose";

/**
 * tailwind.config.ts 里定义的全部 ql-* 名称（颜色、阴影等）。直接读配置文件，保证 lint 与构建用同一份清单；
 * 用了清单外的 ql-* 名称，Tailwind 不会报错，只会不生成样式。
 */
const QL_THEME_NAMES = [
  ...readFileSync(new URL("./apps/web/tailwind.config.ts", import.meta.url), "utf8").matchAll(/"ql-([a-z0-9-]+)"\s*:/g),
]
  .map((match) => match[1])
  .sort((a, b) => b.length - a.length);
if (QL_THEME_NAMES.length === 0) {
  throw new Error("eslint.config.mjs：没从 apps/web/tailwind.config.ts 读到任何 ql-* 名称，检查配置格式。");
}

const VISUAL_SPEC_PATTERNS = [
  {
    pattern: `\\b(${COLOR_UTILITIES})-(${TAILWIND_PALETTE})-[0-9]{2,3}\\b`,
    message: "不要用 Tailwind 默认色板，改用 ql-* 语义令牌（src/styles/tokens.css）。",
  },
  {
    pattern: `\\b(${COLOR_UTILITIES})-(white|black)\\b`,
    message: "实色按钮文字用 text-ql-on-action，遮罩用 bg-ql-overlay，表面用 bg-ql-surface；不写死黑白。",
  },
  {
    pattern: `\\b(${COLOR_UTILITIES})-\\[(#|rgb|hsl|oklch|oklab|lab\\(|lch\\(|hwb|color-mix|color\\()`,
    message: "不要在类名里写死颜色值，改用 ql-* 语义令牌。",
  },
  {
    pattern: `\\b(${COLOR_UTILITIES})-(primary|secondary|destructive|muted|foreground|background|card|popover|warning|success|danger|error|info|brand|accent|surface|input)\\b`,
    message: "这个颜色名在 tailwind.config.ts 里没有定义，不会生成样式；改用 ql-* 语义令牌。",
  },
  {
    pattern: `\\b(${COLOR_UTILITIES})-ql-(?!(?:${QL_THEME_NAMES.join("|")})(?![\\w-]))[a-z0-9-]+`,
    message: "这个 ql-* 名称没在 tailwind.config.ts 里定义，不会生成样式；改用已定义的令牌（如 ql-fg-tertiary、ql-action）。",
  },
  {
    pattern: "(?<![\\w-])text-\\[(?:[0-9]|1[01])(?:\\.[0-9]+)?px\\]",
    message: "字号最小 12px，且只给标签和徽标；说明、表格、辅助文字用 13px，正文 14px。",
  },
  {
    pattern: "(?<![\\w-])rounded(?:-(?:[trblse]|tl|tr|bl|br|ss|se|es|ee))?(?:-(?:sm|xs|3xl|\\[[^\\]]*\\]))?(?![\\w\\[-])",
    message: "圆角只用五档：rounded-md（6px）/ rounded-lg（8px）/ rounded-xl（12px）/ rounded-2xl（16px）/ rounded-full。",
  },
  {
    pattern: "(?<![\\w-])shadow(?:-(?:sm|md|lg|xl|2xl|xs|inner))?(?![\\w\\[-])",
    message: "常驻卡片不加阴影；弹窗、浮层、吸底栏用 shadow-ql-raised。",
  },
  {
    pattern: "(?<![\\w-])text-ql-accent(?![\\w-])",
    message: "青色文字用 text-ql-accent-text（浅色下对比 5.3:1）；ql-accent 只用于图形。每屏只留一个青色关键数。",
  },
];

/** 实色主按钮 / 危险按钮的底色：不带变体前缀的 bg-ql-action / bg-ql-danger，含 50% 以上透明度写法。 */
const SOLID_FILL = "(^|\\s)bg-ql-(action|danger)(\\x2F(?:[5-9][0-9]|100))?(?=\\s|$)";
const SOLID_BUTTON_MESSAGE =
  "按钮用 <Button variant=\"primary|danger\">（src/components/ui/Button.tsx）；<Link> 等非 button 元素用 buttonClassName()；选中态用 bg-ql-action-soft。";
/** 模板字符串在 ${} 前以类名前缀结尾，说明在拼接类名。 */
const CONCATENATED_CLASS = `(^|\\s)((?:[a-z0-9-]+:)*!?(?:${COLOR_UTILITIES})-(?:ql-(?:[a-z0-9-]*-)?)?|ql-[a-z0-9-]*-)$`;

function visualSpecSelectors() {
  const buttonClassName = 'JSXOpeningElement[name.name="button"] > JSXAttribute[name.name="className"]';
  return [
    ...VISUAL_SPEC_PATTERNS.flatMap(({ pattern, message }) => [
      { selector: `Literal[value=/${pattern}/]`, message },
      { selector: `TemplateElement[value.raw=/${pattern}/]`, message },
    ]),
    // <button> 的 className 里任何位置（字符串、表达式容器、条件分支、模板字符串）写了实色底。
    { selector: `${buttonClassName} Literal[value=/${SOLID_FILL}/]`, message: SOLID_BUTTON_MESSAGE },
    { selector: `${buttonClassName} TemplateElement[value.raw=/${SOLID_FILL}/]`, message: SOLID_BUTTON_MESSAGE },
    // 任何字符串里同时出现实色底和 text-ql-on-action：这是手写实色按钮的样式，常见于先存常量再传给 className。
    {
      selector: `Literal[value=/^(?=.*${SOLID_FILL})(?=.*text-ql-on-action)/]`,
      message: SOLID_BUTTON_MESSAGE,
    },
    {
      selector: `TemplateElement[value.raw=/^(?=.*${SOLID_FILL})(?=.*text-ql-on-action)/]`,
      message: SOLID_BUTTON_MESSAGE,
    },
    {
      selector: `TemplateElement[tail=false][value.raw=/${CONCATENATED_CLASS}/]`,
      message:
        "不要拼接类名：Tailwind 只保留源码里完整出现的类名，拼出来的类不会生成样式。改用完整类名映射（参考 src/components/ui/Button.tsx）。",
    },
  ];
}

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
    // 视觉规范拦截（仟流 Web 产品视觉规范 1.0 §13.1）：组件只用 ql-* 语义令牌，按钮只用 <Button>。
    // 字号下限（禁止 text-[10px] / text-[11px]）在字号收敛批次清完存量后再加。
    files: ["apps/web/src/**/*.ts", "apps/web/src/**/*.tsx"],
    ignores: ["apps/web/src/**/*.test.ts", "apps/web/src/**/*.test.tsx"],
    rules: {
      "no-restricted-syntax": ["error", ...visualSpecSelectors()],
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
