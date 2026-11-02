/** Keep the 1080px export width while reducing each 174px side margin by 30%. */
export function companyReportFrame(contentHeight: number, baselineHeight = 760) {
  const width = 540;
  const margin = 87 * 0.7;
  const scale = (width - margin * 2) / (453 - 87);
  const offsetX = margin - 87 * scale;
  // Preserve the existing minimum section gap when a report has more member rows.
  const height = Math.max(baselineHeight, Math.ceil((112 + contentHeight + 3 * 26) * scale));
  return { width, height, scale, offsetX, layoutHeight: height / scale,
    transform: `matrix(${scale} 0 0 ${scale} ${offsetX} 0)` };
}
