/** Set the SVG viewport before Skia rasterizes text, while preserving its coordinates. */
export function prepareSvgRasterSize(svg: string, fitWidth: number): {
  svg: string; width: number; height: number; viewBox: [number, number, number, number];
} {
  if (!Number.isSafeInteger(fitWidth) || fitWidth <= 0) throw new Error("Invalid PNG output width");
  const root = svg.match(/<svg\b[^>]*>/)?.[0];
  if (!root) throw new Error("SVG root element is missing");
  const attribute = (name: string) => root.match(new RegExp(`\\s${name}\\s*=\\s*(["'])(.*?)\\1`))?.[2];
  const dimension = (value?: string) => value && /^\d+(?:\.\d+)?(?:px)?$/.test(value)
    ? Number(value.replace(/px$/, "")) : undefined;
  const rawViewBox = attribute("viewBox");
  const box = rawViewBox?.trim().split(/[\s,]+/).map(Number);
  if (box && (box.length !== 4 || !box.every(Number.isFinite) || box[2]! <= 0 || box[3]! <= 0)) {
    throw new Error("Invalid SVG viewBox");
  }
  const sourceWidth = dimension(attribute("width")) ?? box?.[2];
  const sourceHeight = dimension(attribute("height")) ?? box?.[3];
  if (!sourceWidth || !sourceHeight || !Number.isFinite(sourceWidth) || !Number.isFinite(sourceHeight)) {
    throw new Error("SVG has no renderable dimensions");
  }
  const height = Math.max(1, Math.round(sourceHeight * fitWidth / sourceWidth));
  if (!Number.isSafeInteger(height)) throw new Error("Invalid PNG output height");
  const viewBox = (box ?? [0, 0, sourceWidth, sourceHeight]) as [number, number, number, number];
  // Without a viewBox, enlarging the viewport alone would leave the drawing unscaled.
  const sizedRoot = root.replace(/\s(?:width|height)\s*=\s*(["']).*?\1/g, "")
    .replace(/>$/, `${box ? "" : ` viewBox="${viewBox.join(" ")}"`} width="${fitWidth}" height="${height}">`);
  return { svg: svg.replace(root, sizedRoot), width: fitWidth, height, viewBox };
}
