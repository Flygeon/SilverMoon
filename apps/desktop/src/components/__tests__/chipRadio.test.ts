import { describe, expect, it } from "vitest";
import { resolveChipToggle } from "@/utils/chipSelect";

/**
 * 单选 chip 单击切换的回归测试。
 *
 * 背景：`m3e-filter-chip` 是**自管理选中态**的组件，它的点击处理是
 *
 * ```js
 * handleClick(e) {
 *   if (this.dispatchEvent(new Event("beforeinput", { cancelable: true }))) {
 *     this.selected = !this.selected;   // ← 组件自己翻转
 *   }
 * }
 * ```
 *
 * 而 Vue 的 `@click` 在插入 DOM 之前就挂上了，同一次点击里是「Vue 先、组件后」：
 * Vue 把 model 设成新值并让新 chip 渲染为选中，组件紧接着把它翻回未选中 ——
 * 屏幕上变成「一个都没选中」，用户必须点两次。这正是「切换收藏夹要点两下」的根因。
 *
 * 这里直接测真实实现 `resolveChipToggle`（组件与测试共用同一份逻辑）。
 */
describe("resolveChipToggle", () => {
  it("点到未选中项（组件翻成选中）→ 采用该项", () => {
    expect(resolveChipToggle("A", "B", true)).toEqual({ picked: "B", pin: false });
  });

  it("点到已选中项（组件翻成未选中）→ 保持原值并拨回选中", () => {
    expect(resolveChipToggle("A", "A", false)).toEqual({ picked: "A", pin: true });
  });

  it("数字型值同样适用（收藏夹 id / 清晰度码）", () => {
    expect(resolveChipToggle(80, 112, true)).toEqual({ picked: 112, pin: false });
    expect(resolveChipToggle(80, 80, false)).toEqual({ picked: 80, pin: true });
  });

  it("关键不变式：单选组永远不会落到「一个都没选」", () => {
    // 模拟连续点击若干次，最终一定有且只有一个选中值
    const values = ["A", "B", "C"];
    let model: string | number = "A";
    const clicks: string[] = ["B", "C", "A", "A", "B"];
    for (const clicked of clicks) {
      // 组件先自翻转：点非当前项 → 变选中；点当前项 → 变未选中
      const afterToggle: boolean = clicked !== model;
      model = resolveChipToggle(model, clicked, afterToggle).picked;
      expect(values).toContain(String(model));
    }
    expect(model).toBe("B");
  });
});
