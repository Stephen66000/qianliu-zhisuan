import { createCanvas, Image } from "@napi-rs/canvas";
import { prepareSvgRasterSize } from "./svg-raster-size.js";

export interface RenderPngOptions {
  fitWidth?: number;
  defaultFontFamily?: string;
}

/**
 * 将 SVG 渲染为 PNG，保留模板的中文字体与内嵌 PNG 品牌图。
 */
export async function renderSvgToPng(svgString: string, options?: RenderPngOptions): Promise<Buffer> {
  const fitWidth = options?.fitWidth ?? 540;
  const defaultFamily = options?.defaultFontFamily ??
    (process.platform === "darwin" ? "Hiragino Sans GB" : "WenQuanYi Zen Hei");
  const escapedFamily = defaultFamily.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
  // Skia 的 SVG 解码器只取字体列表首项，映射模板字体栈到已安装的中文字体。
  const templateFontStack = "-apple-system, BlinkMacSystemFont, 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'WenQuanYi Zen Hei', 'Noto Sans CJK SC', sans-serif";
  const embeddedPngs: Array<{ data: Buffer; x: number; y: number; width: number; height: number }> = [];
  const withoutEmbeddedPngs = svgString.replace(
    /<image\b[^>]*\bhref="data:image\/png;base64,[^"]+"[^>]*\/>/g,
    (tag) => {
      const attribute = (name: string): string | undefined => tag.match(new RegExp(`\\b${name}="([^"]+)"`))?.[1];
      const base64 = tag.match(/\bhref="data:image\/png;base64,([^"]+)"/)?.[1];
      const x = Number(attribute("x"));
      const y = Number(attribute("y"));
      const width = Number(attribute("width"));
      const height = Number(attribute("height"));
      if (!base64 || ![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) {
        throw new Error("Invalid embedded PNG in SVG");
      }
      embeddedPngs.push({ data: Buffer.from(base64, "base64"), x, y, width, height });
      return "";
    },
  );
  const svg = withoutEmbeddedPngs
    .replaceAll(`font-family="${templateFontStack}"`, `font-family="${escapedFamily}"`)
    .replace(/<svg\b(?![^>]*\bfont-family=)/, `<svg font-family="${escapedFamily}"`);
  const raster = prepareSvgRasterSize(svg, fitWidth);
  const image = new Image();
  image.src = Buffer.from(raster.svg);
  await image.decode();
  if (image.width <= 0 || image.height <= 0) throw new Error("SVG has no renderable dimensions");
  if (image.width !== raster.width || image.height !== raster.height) {
    throw new Error("SVG decoder did not preserve the requested raster dimensions");
  }
  const outputHeight = raster.height;
  const bitmaps = await Promise.all(embeddedPngs.map(async (embedded) => {
    const bitmap = new Image();
    bitmap.src = embedded.data;
    await bitmap.decode();
    return bitmap;
  }));
  const canvas = createCanvas(fitWidth, outputHeight);
  const context = canvas.getContext("2d");
  context.drawImage(image, 0, 0);

  if (embeddedPngs.length > 0) {
    const [minX, minY, viewWidth, viewHeight] = raster.viewBox;
    const scale = Math.min(fitWidth / viewWidth, outputHeight / viewHeight);
    const offsetX = (fitWidth - viewWidth * scale) / 2;
    const offsetY = (outputHeight - viewHeight * scale) / 2;
    for (const [index, embedded] of embeddedPngs.entries()) {
      const bitmap = bitmaps[index]!;
      context.drawImage(bitmap, offsetX + (embedded.x - minX) * scale,
        offsetY + (embedded.y - minY) * scale, embedded.width * scale, embedded.height * scale);
    }
  }
  return canvas.toBuffer("image/png");
}
