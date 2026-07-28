/**
 * Tailwind 配置（W18）—— 仟流 Web 产品视觉规范 §13.2 集成示例落地。
 *
 * 语义令牌全部走 RGB 通道 CSS 变量（src/styles/tokens.css），
 * 组件只允许使用语义类名（bg-ql-canvas / text-ql-fg / border-ql-border …），
 * 禁止硬编码 hex / text-gray-* / dark:bg-slate-*（规范 §13.1 硬编码禁令）。
 * 深浅主题由 <html data-theme> 切换变量值，不使用 dark: 变体复制两套颜色。
 */
import type { Config } from "tailwindcss";

const ql = (variable: string) => `rgb(var(${variable}) / <alpha-value>)`;

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        "ql-canvas": ql("--ql-canvas"),
        "ql-surface": ql("--ql-surface"),
        "ql-surface-raised": ql("--ql-surface-raised"),
        "ql-surface-subtle": ql("--ql-surface-subtle"),
        "ql-surface-muted": ql("--ql-surface-muted"),
        "ql-surface-brand-soft": ql("--ql-surface-brand-soft"),
        "ql-border": ql("--ql-border"),
        "ql-border-strong": ql("--ql-border-strong"),
        "ql-border-zone": ql("--ql-border-zone"),
        "ql-fg": ql("--ql-text-primary"),
        "ql-fg-secondary": ql("--ql-text-secondary"),
        "ql-fg-tertiary": ql("--ql-text-tertiary"),
        "ql-fg-disabled": ql("--ql-text-disabled"),
        "ql-action": ql("--ql-action-primary"),
        "ql-action-hover": ql("--ql-action-primary-hover"),
        "ql-action-soft": ql("--ql-action-primary-soft"),
        "ql-accent": ql("--ql-accent-visual"),
        "ql-accent-text": ql("--ql-accent-text"),
        "ql-success": ql("--ql-success"),
        "ql-success-soft": ql("--ql-success-soft"),
        "ql-warning": ql("--ql-warning"),
        "ql-warning-soft": ql("--ql-warning-soft"),
        "ql-danger": ql("--ql-danger"),
        "ql-danger-soft": ql("--ql-danger-soft"),
      },
      fontFamily: {
        sans: ["var(--ql-font-sans)"],
        mono: ["var(--ql-font-mono)"],
      },
      boxShadow: {
        "ql-raised": "var(--ql-shadow-raised)",
        "ql-zone-focus": "var(--ql-shadow-zone-focus)",
      },
    },
  },
  plugins: [],
} satisfies Config;
