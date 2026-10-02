import { createCanvas, Image } from "@napi-rs/canvas";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderSvgToPng } from "../render-png.js";

afterEach(() => vi.restoreAllMocks());

describe("SVG raster resolution and coordinate preservation", () => {
  it("rasterizes text at 1080x1520 before drawing, rather than decoding a 540px bitmap", async () => {
    const sizes: Array<[number, number]> = [];
    const decode = Image.prototype.decode;
    vi.spyOn(Image.prototype, "decode").mockImplementation(async function (this: Image) {
      const result = await decode.call(this);
      sizes.push([this.width, this.height]);
      return result;
    });
    const png = await renderSvgToPng('<svg xmlns="http://www.w3.org/2000/svg" width="540" height="760" viewBox="0 0 540 760"><text x="30" y="60" font-size="20">日报 123</text></svg>', { fitWidth: 1080 });
    expect(sizes[0]).toEqual([1080, 1520]);
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([1080, 1520]);
  });

  it.each([540, 1080])("keeps a PNG logo aligned with vector coordinates in a cropped viewBox at %ipx", async (fitWidth) => {
    const logo = createCanvas(2, 2);
    logo.getContext("2d").fillStyle = "#ff0000";
    logo.getContext("2d").fillRect(0, 0, 2, 2);
    const image = `<image x="12" y="22" width="4" height="4" href="data:image/png;base64,${logo.toBuffer("image/png").toString("base64")}"/>`;
    const root = '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="10" viewBox="10 20 20 10">';
    const bitmap = await renderSvgToPng(`${root}<rect x="10" y="20" width="20" height="10" fill="white"/>${image}</svg>`, { fitWidth });
    const vector = await renderSvgToPng(`${root}<rect x="10" y="20" width="20" height="10" fill="white"/><rect x="12" y="22" width="4" height="4" fill="red"/></svg>`, { fitWidth });
    const decoded = new Image(); decoded.src = bitmap; await decoded.decode();
    const reference = new Image(); reference.src = vector; await reference.decode();
    const canvas = createCanvas(fitWidth, fitWidth / 2);
    const context = canvas.getContext("2d"); context.drawImage(decoded, 0, 0);
    const point = [Math.round(fitWidth * 0.2), Math.round(fitWidth * 0.2)];
    const actual = [...context.getImageData(point[0]!, point[1]!, 1, 1).data];
    context.drawImage(reference, 0, 0);
    expect(actual).toEqual([...context.getImageData(point[0]!, point[1]!, 1, 1).data]);
    expect(actual).toEqual([255, 0, 0, 255]);
    expect([...context.getImageData(0, 0, 1, 1).data]).toEqual([255, 255, 255, 255]);
  });

  it("scales SVGs without a viewBox by retaining their original coordinate bounds", async () => {
    const png = await renderSvgToPng('<svg xmlns="http://www.w3.org/2000/svg" width="20" height="10"><rect x="10" y="0" width="10" height="10" fill="red"/></svg>', { fitWidth: 40 });
    const decoded = new Image(); decoded.src = png; await decoded.decode();
    const canvas = createCanvas(40, 20); const context = canvas.getContext("2d"); context.drawImage(decoded, 0, 0);
    expect([...context.getImageData(30, 10, 1, 1).data]).toEqual([255, 0, 0, 255]);
    expect([...context.getImageData(10, 10, 1, 1).data]).toEqual([0, 0, 0, 0]);
  });

  it.each([0, -1, 1080.5, Number.NaN])("rejects invalid output width %s", async (fitWidth) => {
    await expect(renderSvgToPng('<svg width="540" height="760"></svg>', { fitWidth })).rejects.toThrow("Invalid PNG output width");
  });
});
