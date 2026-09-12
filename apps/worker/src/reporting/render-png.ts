import { Resvg } from "@resvg/resvg-js";

export interface RenderPngOptions {
  fitWidth?: number;
  defaultFontFamily?: string;
}

/**
 * 将纯 SVG 字符串渲染为高清 PNG 图像 Buffer
 * 默认宽度 540px，支持系统字体与 Retina 高清放大
 */
export function renderSvgToPng(svgString: string, options?: RenderPngOptions): Buffer {
  const fitWidth = options?.fitWidth ?? 540;
  const resvg = new Resvg(svgString, {
    fitTo: { mode: "width", value: fitWidth },
    font: {
      loadSystemFonts: true,
      defaultFontFamily: options?.defaultFontFamily ?? "-apple-system",
    },
  });
  const pngData = resvg.render();
  return Buffer.from(pngData.asPng());
}
