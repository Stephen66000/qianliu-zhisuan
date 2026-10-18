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
