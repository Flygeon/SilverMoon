/**
 * 洪水填充的边界回归测试。
 *
 * 填充最容易错在两处：**边界差一像素**（左右扩展多走/少走一格）与
 * **起点已是目标色**时不该产生改动。这两点肉眼很难看出来（都是「差不多」），
 * 但在小矩阵上可以精确断言。
 */
import { describe, expect, it } from "vitest";
import { floodFill, sameColor, type Rgba } from "../floodFill";

const WHITE: Rgba = { r: 255, g: 255, b: 255, a: 255 };
const BLACK: Rgba = { r: 0, g: 0, b: 0, a: 255 };
const RED: Rgba = { r: 255, g: 0, b: 0, a: 255 };

/** 由字符串画布造像素数组：'.' = 白，'#' = 黑。行首行尾不许有多余空格。 */
function make(rows: string[]): { data: Uint8ClampedArray; width: number; height: number } {
  const height = rows.length;
  const width = rows[0].length;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const c = rows[y][x] === "#" ? BLACK : WHITE;
      const i = (y * width + x) * 4;
      data[i] = c.r;
      data[i + 1] = c.g;
      data[i + 2] = c.b;
      data[i + 3] = c.a;
    }
  }
  return { data, width, height };
}

/** 取某像素颜色。 */
function at(data: Uint8ClampedArray, width: number, x: number, y: number): Rgba {
  const i = (y * width + x) * 4;
  return { r: data[i], g: data[i + 1], b: data[i + 2], a: data[i + 3] };
}

describe("sameColor", () => {
  it("容差 0 时只有完全相同才算同色", () => {
    expect(sameColor(WHITE, WHITE)).toBe(true);
    expect(sameColor(WHITE, { ...WHITE, r: 254 })).toBe(false);
  });

  it("容差按每通道差值判定", () => {
    expect(sameColor({ r: 10, g: 10, b: 10, a: 255 }, { r: 12, g: 9, b: 11, a: 255 }, 2)).toBe(
      true,
    );
    expect(sameColor({ r: 10, g: 10, b: 10, a: 255 }, { r: 13, g: 10, b: 10, a: 255 }, 2)).toBe(
      false,
    );
  });
});

describe("floodFill", () => {
  it("填满整张同色画布", () => {
    const { data, width, height } = make(["..", ".."]);
    expect(floodFill(data, width, height, 0, 0, RED)).toBe(4);
    expect(at(data, width, 1, 1)).toEqual(RED);
  });

  it("被墙围住时不越界", () => {
    // 3x3，中间一圈是黑墙，只有中心一格是白
    const { data, width, height } = make(["###", "#.#", "###"]);
    expect(floodFill(data, width, height, 1, 1, RED)).toBe(1);
    expect(at(data, width, 1, 1)).toEqual(RED);
    // 墙外仍是白（没被误填）
    expect(at(data, width, 0, 0)).toEqual(BLACK);
  });

  it("沿对角缝隙不应泄漏（四邻域语义）", () => {
    // 对角相连的两块白，四邻域下不连通：起点那块填色，另一块保持原样
    const { data, width, height } = make([".#", "#."]);
    expect(floodFill(data, width, height, 0, 0, RED)).toBe(1);
    expect(at(data, width, 0, 0)).toEqual(RED);
    expect(at(data, width, 1, 1)).toEqual(WHITE);
  });

  it("起点已是目标色时不做改动（返回 0）", () => {
    const { data, width, height } = make(["..", ".."]);
    expect(floodFill(data, width, height, 0, 0, WHITE)).toBe(0);
  });

  it("起点越界时安全返回 0", () => {
    const { data, width, height } = make(["..", ".."]);
    expect(floodFill(data, width, height, -1, 0, RED)).toBe(0);
    expect(floodFill(data, width, height, 0, 5, RED)).toBe(0);
    expect(floodFill(data, width, height, 2, 0, RED)).toBe(0);
  });

  it("能填满 U 形（会绕回来的一段）", () => {
    // 白区是一个 U：上排全白、左右两列白、底排全白，中间被黑隔开
    const { data, width, height } = make(["...", ".#.", "..."]);
    // 从左上角进，能绕到底部并覆盖 8 个白格
    expect(floodFill(data, width, height, 0, 0, RED)).toBe(8);
    expect(at(data, width, 1, 1)).toEqual(BLACK);
    expect(at(data, width, 2, 2)).toEqual(RED);
  });

  it("大画布不爆栈（扫描线 + 显式栈的意义）", () => {
    const w = 600;
    const h = 600;
    const data = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < data.length; i += 4) {
      data[i] = 255;
      data[i + 1] = 255;
      data[i + 2] = 255;
      data[i + 3] = 255;
    }
    expect(floodFill(data, w, h, 0, 0, RED)).toBe(w * h);
  });
});
