// @vitest-environment node
import { fileURLToPath } from "node:url";

import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

const repositoryRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const eslint = new ESLint({
  cwd: repositoryRoot,
  // 与项目的 React 依赖一致，避免根目录检测不到 React 时产生无关提示。
  overrideConfig: { settings: { react: { version: "19.1.1" } } },
});
const filePath = "apps/web/src/visual-lint-fixture.tsx";

async function visualMessages(source: string): Promise<string[]> {
  const [result] = await eslint.lintText(source, { filePath });
  expect(result?.fatalErrorCount).toBe(0);
  return result!.messages
    .filter((message) => message.ruleId === "no-restricted-syntax")
    .map((message) => message.message);
}

describe("视觉规范 lint：复核回归夹具", () => {
  it.each([
    ["JSX 表达式字符串", '<button className={"bg-ql-action"}>保存</button>'],
    ["三元表达式", '<button className={true ? "bg-ql-action" : "bg-ql-danger"}>保存</button>'],
    ["透明度 90", '<button className="bg-ql-action/90">保存</button>'],
    ["字符串属性", '<button className="bg-ql-action">保存</button>'],
    ["模板字符串", '<button className={`bg-ql-danger px-4`}>保存</button>'],
    ["逻辑与", '<button className={true && "bg-ql-action"}>保存</button>'],
    ["cn 参数", '<button className={cn("px-4", "bg-ql-action")}>保存</button>'],
    ["clsx 对象参数", '<button className={clsx({ "bg-ql-danger": true })}>保存</button>'],
  ])("拦截手写实色按钮：%s", async (_name, jsx) => {
    const messages = await visualMessages(`export const Fixture = () => ${jsx};`);
    expect(messages.some((message) => message.includes("按钮用 <Button"))).toBe(true);
  });

  it("拦截保存到常量的实色按钮样式", async () => {
    const messages = await visualMessages('const fill = "bg-ql-action text-ql-on-action"; export const Fixture = () => <button className={fill}>保存</button>;');
    expect(messages.some((message) => message.includes("按钮用 <Button"))).toBe(true);
  });

  it.each([
    "hover:bg-ql-action", "dark:bg-ql-danger", "!bg-ql-action",
    "sm:dark:hover:!bg-ql-danger/50", "dark:bg-ql-action/100",
    "group-hover/menu:bg-ql-action/90", "data-[state=open]:bg-ql-danger",
    "[&:hover]:bg-ql-action", "[&::before]:bg-ql-action",
    "supports-[display:grid]:hover:!bg-ql-danger",
  ])("拦截带变体或 important 的实色按钮：%s", async (value) => {
    const messages = await visualMessages(`export const Fixture = () => <button className=${JSON.stringify(value)}>保存</button>;`);
    expect(messages.some((message) => message.includes("按钮用 <Button"))).toBe(true);
  });

  it.each([
    'export const Fixture = () => <button className={`px-4 dark:hover:!bg-ql-danger/90`}>保存</button>;',
    'const fill = "hover:bg-ql-action text-ql-on-action"; export const Fixture = () => <button className={fill}>保存</button>;',
    'const fill = `\ntext-ql-on-action\nsm:dark:!bg-ql-danger/50\n`; export const Fixture = () => <button className={fill}>保存</button>;',
    'const fill = "hover:bg-ql-action\\ntext-ql-on-action"; export const Fixture = () => <button className={fill}>保存</button>;',
  ])("模板和常量也拦截带前缀的实色按钮：%s", async (source) => {
    const messages = await visualMessages(source);
    expect(messages.some((message) => message.includes("按钮用 <Button"))).toBe(true);
  });

  it.each([
    '<button className="hover:bg-ql-action-soft">选中</button>',
    '<button className="dark:hover:!bg-ql-danger-soft">选中</button>',
    '<button className="hover:bg-ql-action/49">选中</button>',
    '<button className="dark:!bg-ql-danger/40">选中</button>',
    '<button className="bg-ql-action/0">选中</button>',
    '<button className="dark:hover:bg-ql-action-hover">选中</button>',
    '<div className="hover:bg-ql-action">内容</div>',
  ])("前缀修复仍放过弱底、低透明度及非按钮背景：%s", async (jsx) => {
    expect(await visualMessages(`export const Fixture = () => ${jsx};`)).toEqual([]);
  });

  it.each(["dark:hover:!bg-ql-danger-soft", "dark:!bg-ql-danger/40"])("弱底常量保留合法语义：%s", async (value) => {
    expect(await visualMessages(`const fill = ${JSON.stringify(`${value} text-ql-on-action`)}; export const Fixture = () => <button className={fill}>选中</button>;`)).toEqual([]);
  });

  it.each([
    "text-ql-fg-muted", "bg-ql-surface-warning-soft", "bg-ql-surface-danger-soft",
    "border-ql-brand", "text-ql-brand", "hover:bg-ql-action-subtle",
    "border-warning/30", "bg-warning/10", "text-warning",
    "text-ql-not-defined", "text-ql-fg-tertiary-extra",
  ])("拦截未定义颜色：%s", async (value) => {
    const messages = await visualMessages(`export const value = ${JSON.stringify(value)};`);
    expect(messages.some((message) => message.includes("没在 tailwind.config.ts") || message.includes("没有定义"))).toBe(true);
  });

  it.each(["ring-white", "outline-black", "ring-[#123456]", "border-t-red-500"])("仍拦截首轮漏拦颜色：%s", async (value) => {
    expect(await visualMessages(`export const value = ${JSON.stringify(value)};`)).not.toEqual([]);
  });

  it("拦截模板中的动态按钮类名", async () => {
    const messages = await visualMessages('export const value = (size: string) => `ql-btn-${size}`;');
    expect(messages.some((message) => message.includes("不要拼接类名"))).toBe(true);
  });

  it.each([
    '<Button variant="primary">保存</Button>',
    '<button className="bg-ql-action-soft text-ql-action">选中</button>',
    '<button className="text-ql-action hover:bg-ql-action-soft">展开</button>',
    '<button className="border-ql-border bg-ql-surface text-ql-fg">取消</button>',
  ])("放过组件和语义弱底：%s", async (jsx) => {
    expect(await visualMessages(`export const Fixture = () => ${jsx};`)).toEqual([]);
  });

  it.each([
    "text-ql-fg-tertiary/60", "border-t-ql-border", "ring-offset-ql-canvas", "shadow-ql-raised",
    "bg-ql-warning-soft text-ql-warning", "text-[13px] border-2 shadow-ql-raised",
  ])("放过已定义令牌和非颜色工具类：%s", async (value) => {
    expect(await visualMessages(`export const value = ${JSON.stringify(value)};`)).toEqual([]);
  });
});

describe("视觉规范 lint：字号与形状收敛（第二批）", () => {
  it.each([
    ["10px", "text-[10px] text-ql-fg-tertiary", "字号最小 12px"],
    ["11px 带变体", "md:text-[11px]", "字号最小 12px"],
    ["4px 圆角", "rounded border px-2", "圆角只用五档"],
    ["单边 4px 圆角", "rounded-t bg-ql-surface", "圆角只用五档"],
    ["任意圆角值", "rounded-[7px]", "圆角只用五档"],
    ["常驻卡片阴影", "rounded-xl border shadow-sm", "常驻卡片不加阴影"],
    ["默认浮层阴影", "fixed shadow-xl", "常驻卡片不加阴影"],
    ["青色小字", "text-ql-accent font-bold", "青色文字用 text-ql-accent-text"],
  ])("拦截：%s", async (_name, value, expected) => {
    const messages = await visualMessages(`export const value = ${JSON.stringify(value)};`);
    expect(messages.some((message) => message.includes(expected))).toBe(true);
  });

  it.each([
    "text-[12px] text-[13px] text-[14px] text-xs",
    "rounded-md rounded-lg rounded-xl rounded-2xl rounded-full rounded-t-md",
    "shadow-ql-raised shadow-ql-zone-focus shadow-none drop-shadow-sm",
    "text-ql-accent-text bg-ql-accent-text",
  ])("放过：%s", async (value) => {
    expect(await visualMessages(`export const value = ${JSON.stringify(value)};`)).toEqual([]);
  });
});
