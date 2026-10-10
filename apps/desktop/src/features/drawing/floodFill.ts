/**
 * 洪水填充（油漆桶）的**纯算法**。
 *
 * 单独成模块而不是写在组件里，是为了能单测：填充最容易出的错是
 * 「边界处理差一像素」和「大图爆栈」，两者都很难靠肉眼验证，
 * 但在纯函数里用几个小矩阵就能钉死。
 *
 * ## 为什么用**扫描线**而不是逐像素四邻域
 *
 * 朴素四邻域对每个像素压一次栈，一张 1600×900 的画布最坏要压上百万次；
 * 扫描线一次处理一整行连续区段，栈深度降一个量级，且对「大片同色区域」
 * （正是油漆桶最常遇到的场景）快得多。
 *
 * ## 为什么用显式栈而不是递归
 *
 * 递归深度等于填充区域的跨度，大图直接爆栈。显式栈没有这个上限。
 */

/** RGBA 像素，各分量 0..255。 */
export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

/** 颜色是否在容差内视为同色。
 *
 * 容差按「每通道差值都不超过 tolerance」判定（而不是欧氏距离）：
 * 前者更符合「我以为这两个颜色一样」的直觉，也更好解释。
 */
export function sameColor(a: Rgba, b: Rgba, tolerance = 0): boolean {
  return (
    Math.abs(a.r - b.r) <= tolerance &&
    Math.abs(a.g - b.g) <= tolerance &&
    Math.abs(a.b - b.b) <= tolerance &&
    Math.abs(a.a - b.a) <= tolerance
  );
}

/**
 * 从 (startX, startY) 开始洪水填充，就地修改 `pixels`。
 *
 * `pixels` 是**行优先的 RGBA 字节数组**（长度 = width * height * 4），
 * 与 `ImageData.data` 一致，调用方可以直接传 canvas 的数据。
 *
 * 返回**被改动的像素数**（0 表示起点已经是目标色，什么都没做）。
 * 返回值让调用方判断「要不要记进撤销栈」——没改动就不该产生一步历史。
 */
export function floodFill(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  startX: number,
  startY: number,
  target: Rgba,
  tolerance = 0,
): number {
  // 起点越界：直接当无事发生，不抛错（调用方可能传来边缘外的坐标）
  if (startX < 0 || startY < 0 || startX >= width || startY >= height) return 0;

  const idxOf = (x: number, y: number) => (y * width + x) * 4;
  const readAt = (x: number, y: number): Rgba => {
    const i = idxOf(x, y);
    return { r: pixels[i], g: pixels[i + 1], b: pixels[i + 2], a: pixels[i + 3] };
  };

  const seed = readAt(startX, startY);
  // 起点已经是目标色：提前返回，避免整片区域被反复扫描
  if (sameColor(seed, target, tolerance)) return 0;

  const fill = (x: number, y: number) => {
    const i = idxOf(x, y);
    pixels[i] = target.r;
    pixels[i + 1] = target.g;
    pixels[i + 2] = target.b;
    pixels[i + 3] = target.a;
  };

  let changed = 0;
  // 显式栈：每个元素是一条待处理的种子点（扫描线会把它所在的整段吃掉）
  const stack: number[] = [startX, startY];

  while (stack.length) {
    const y = stack.pop()!;
    const x0 = stack.pop()!;
    if (y < 0 || y >= height) continue;
    if (!sameColor(readAt(x0, y), seed, tolerance)) continue;

    // 向左右扩展出这一行的连续段
    let left = x0;
    while (left > 0 && sameColor(readAt(left - 1, y), seed, tolerance)) left--;
    let right = x0;
    while (right < width - 1 && sameColor(readAt(right + 1, y), seed, tolerance)) right++;

    // 填充整段
    for (let x = left; x <= right; x++) {
      fill(x, y);
      changed++;
    }

    // 上下两行只压**连续段的首个像素**作为种子。
    //
    // 为什么不每个像素都压：那样一次扫描会产生 O(段长) 个栈元素，
    // 而它们大多会被后续的「起点已被填充」判断丢弃 —— 白占内存与时间。
    // 只压段首，是因为扫描线在处理该种子时会自己把整段吃掉。
    for (const ny of [y - 1, y + 1]) {
      if (ny < 0 || ny >= height) continue;
      for (let x = left; x <= right; x++) {
        if (!sameColor(readAt(x, ny), seed, tolerance)) continue;
        // 左边仍可填充 ⇒ 当前像素不是段首，跳过（它会被同段的那个种子覆盖）
        if (x > left && sameColor(readAt(x - 1, ny), seed, tolerance)) continue;
        stack.push(x, ny);
      }
    }
  }

  return changed;
}
