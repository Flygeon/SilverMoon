import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * 单选 chip「单击即切换」的回归测试。
 *
 * `m3e-filter-chip` 的点击处理开头是：
 *
 * ```js
 * handleClick(e) {
 *   if (e.defaultPrevented) return;              // ← 关键
 *   if (this.dispatchEvent(new Event("beforeinput", { cancelable: true }))) {
 *     this.selected = !this.selected;            // ← 组件自己翻转
 *   }
 * }
 * ```
 *
 * 而 Vue 的 `@click` 在插入 DOM 前就挂上了，同一次点击里是「Vue 先、组件后」：
 * Vue 先把 model 改成新值、让新 chip 渲染为选中，组件紧接着把它翻回未选中 ——
 * 屏幕上变成「一个都没选中」，必须点第二次。收藏夹、清晰度、评论排序、番剧线路、
 * 音乐排序都中过这个招。
 *
 * 解法是在 `@click` 上加 `.prevent`，用库自己那条 `defaultPrevented` 提前返回，
 * 阻止它自翻转。这里用纯函数把两种写法的结果固定下来。
 */

/** 模拟一次点击后的选中项。`prevented` 对应 @click.prevent。 */
function clickResult(
  values: string[],
  current: string,
  clicked: string,
  prevented: boolean,
): string[] {
  // 1) Vue 的 @click 先跑：设置新的选中值
  let model = clicked;
  const rendered = values.filter((v) => v === model);
  // 2) 组件 handleClick 后跑：prevented 时提前返回，否则翻转自己
  if (prevented) return rendered;
  const self = { value: clicked, selected: rendered.includes(clicked) };
  self.selected = !self.selected;
  return values.filter((v) => (v === clicked ? self.selected : v === model && v !== clicked));
}

const VALUES = ["A", "B", "C"];

describe("单选 chip 点击行为", () => {
  it("不加 .prevent：单击后一个都没选中（即需要点两次）", () => {
    expect(clickResult(VALUES, "A", "B", false)).toEqual([]);
  });

  it("加 .prevent：单击即选中目标项", () => {
    expect(clickResult(VALUES, "A", "B", true)).toEqual(["B"]);
    expect(clickResult(VALUES, "A", "C", true)).toEqual(["C"]);
  });
});

/**
 * 静态守卫：全项目所有直接使用 m3e-filter-chip 且绑定 @click 的地方
 * 都必须带 .prevent，否则又会退回「点两次」。
 *
 * 这条断言能在 CI 上拦住新页面踩同一个坑。
 */
function vueFiles(dir: string, acc: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) vueFiles(p, acc);
    else if (e.endsWith(".vue")) acc.push(p);
  }
  return acc;
}

describe("m3e-filter-chip 必须用 @click.prevent", () => {
  it("所有裸 chip 的 @click 都带 .prevent", () => {
    const root = new URL("../../", import.meta.url).pathname;
    const bad: string[] = [];
    for (const file of vueFiles(root)) {
      const src = readFileSync(file, "utf8");
      // 逐个 chip 开标签检查
      const blocks = src.match(/<m3e-filter-chip\b[\s\S]*?>/g) ?? [];
      for (const b of blocks) {
        if (/@click=/.test(b) && !/@click\.prevent=/.test(b)) bad.push(file);
      }
    }
    expect([...new Set(bad)]).toEqual([]);
  });
});
