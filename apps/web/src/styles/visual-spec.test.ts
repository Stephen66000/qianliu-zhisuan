// @vitest-environment node
/**
 * 视觉规范的构建期守卫：用项目自己的 Tailwind 3 和 tailwind.config.ts 真实编译 index.css，
 * 检查两类“构建不报错、页面却没样式”的问题。
 *
 * 1. index.css 的 @layer components（按钮、标识）只有在源码里以完整类名出现时才会进入产物；
 *    变体类名靠字符串拼接得到时，这些规则会被静默裁掉（0002 曾因此让登录按钮变成透明底）。
 * 2. 用了 tailwind.config.ts 里没定义的 ql-* 颜色名，Tailwind 只是不生成样式。
 *
 * 编译时只扫描非测试源码：测试文件里出现的类名不能替业务代码“保活”。
 * 本文件也刻意不写任何完整的 ql-* 类名，类名都从 index.css 和 Button 组件里取。
 */
import { readdirSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";

import { buttonClassName, type ButtonSize, type ButtonVariant } from "../components/ui/Button";

const WEB_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SRC_ROOT = join(WEB_ROOT, "src");
const INDEX_CSS = join(SRC_ROOT, "styles", "index.css");
const require = createRequire(import.meta.url);

/** 接受颜色的工具类前缀，与 eslint.config.mjs 的视觉规范规则保持一致。 */
const COLOR_UTILITIES =
  "bg|text|border(?:-[xytrblse])?|ring(?:-offset)?|outline|divide|fill|stroke|from|via|to|placeholder|shadow|accent|caret|decoration";
/** 源码里的 ql-* 颜色类，含变体前缀（hover: 等）、important（!）和透明度（/90）。 */
const QL_COLOR_CLASS = new RegExp(
  `(?<![\\w-])((?:[a-z0-9-]+:)*!?(?:${COLOR_UTILITIES})-ql-[a-z0-9-]+(?:\\/\\d{1,3})?)(?![\\w/-])`,
  "g",
);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(entry.name) && !/\.test\.(ts|tsx)$/.test(entry.name) ? [path] : [];
  });
}

/** Tailwind 产物里的类名转义：`hover:bg-x/90` → `hover\:bg-x\/90`。 */
function escapeClassName(name: string): string {
  return name.replace(/[:/!.[\]#%()]/g, (char) => `\\${char}`);
}

let builtCss = "";

beforeAll(() => {
  // 使用项目安装的真实 Tailwind CLI 及其配套 PostCSS；避免两份 PostCSS 类型相互比较。
  // --content 显式排除测试，测试夹具不能替业务源码保留类名。
  builtCss = execFileSync(process.execPath, [
    require.resolve("tailwindcss/lib/cli.js"), "--input", INDEX_CSS,
    "--config", join(WEB_ROOT, "tailwind.config.ts"),
    "--content", [join(WEB_ROOT, "index.html"), ...sourceFiles(SRC_ROOT)].join(","),
  ], { cwd: WEB_ROOT, encoding: "utf8", timeout: 55_000, stdio: ["ignore", "pipe", "pipe"] });
}, 60_000);

describe("视觉规范：Tailwind 构建产物", () => {
  it("index.css 里定义的 ql-* 类都进入了产物（没有被拼接类名裁掉）", () => {
    const defined = new Set(
      [...readFileSync(INDEX_CSS, "utf8").matchAll(/\.(ql-[a-z0-9-]+)/g)].map((match) => match[1]),
    );
    expect(defined.size).toBeGreaterThan(5);
    const missing = [...defined].filter((name) => !new RegExp(`\\.${name}(?![\\w-])`).test(builtCss));
    expect(missing).toEqual([]);
  });

  it("Button 每个变体、尺寸输出的类名都有样式", () => {
    const variants: ButtonVariant[] = ["primary", "secondary", "ghost", "danger"];
    const sizes: ButtonSize[] = ["md", "sm", "form"];
    for (const variant of variants) {
      for (const size of sizes) {
        for (const name of buttonClassName(variant, size).split(" ")) {
          expect(builtCss, `${variant}/${size} 缺少 .${name}`).toMatch(new RegExp(`\\.${name}\\s*\\{`));
        }
      }
    }
  });

  it("源码里用到的 ql-* 颜色类都生成了样式（名称都在 tailwind.config.ts 里定义）", () => {
    const used = new Map<string, string>();
    for (const file of [...sourceFiles(SRC_ROOT), join(WEB_ROOT, "index.html")]) {
      for (const match of readFileSync(file, "utf8").matchAll(QL_COLOR_CLASS)) {
        const name = match[1];
        if (name !== undefined && !used.has(name)) used.set(name, relative(WEB_ROOT, file));
      }
    }
    expect(used.size).toBeGreaterThan(50);
    const missing = [...used]
      .filter(([name]) => !builtCss.includes(`.${escapeClassName(name)}`))
      .map(([name, file]) => `${name}（${file}）`);
    expect(missing).toEqual([]);
  });
});
