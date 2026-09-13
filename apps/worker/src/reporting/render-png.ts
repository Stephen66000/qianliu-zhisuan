import { Resvg, type ResvgRenderOptions } from "@resvg/resvg-js";
import { existsSync } from "node:fs";

export interface RenderPngOptions {
  fitWidth?: number;
  defaultFontFamily?: string;
}

/**
 * 将纯 SVG 字符串渲染为高清 PNG 图像 Buffer
 * 自动适配 macOS（本地开发/测试）与 Linux/Alpine（Docker 生产环境）字体
 */
export function renderSvgToPng(svgString: string, options?: RenderPngOptions): Buffer {
  const fitWidth = options?.fitWidth ?? 540;

  // 探测 Alpine / Linux 常用中文字体与西文字体目录
  const candidateDirs = [
    "/usr/share/fonts",
    "/usr/share/fonts/wqy-zenhei",
    "/usr/share/fonts/dejavu",
    "/usr/local/share/fonts",
  ];
  const fontDirs = candidateDirs.filter((d) => existsSync(d));

  const isDarwin = process.platform === "darwin";

  const renderOptions: ResvgRenderOptions = {
    fitTo: { mode: "width", value: fitWidth },
    font: {
      loadSystemFonts: true,
      fontDirs: fontDirs.length > 0 ? fontDirs : undefined,
      defaultFontFamily:
        options?.defaultFontFamily ??
        (isDarwin ? "-apple-system" : "WenQuanYi Zen Hei"),
      sansSerifFamily: isDarwin ? "PingFang SC" : "WenQuanYi Zen Hei",
      serifFamily: isDarwin ? "Georgia" : "DejaVu Serif",
    },
  };

  const resvg = new Resvg(svgString, renderOptions);
  const pngData = resvg.render();
  return Buffer.from(pngData.asPng());
}
