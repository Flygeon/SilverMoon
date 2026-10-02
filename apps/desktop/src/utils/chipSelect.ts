/**
 * 单选 chip 的点击决策（纯函数，便于测试）。
 *
 * `m3e-filter-chip` 是自管理选中态的组件，点击时它会**自己**把 `selected` 翻转，
 * 之后的 `input` 事件里读到的 `element.selected` 已经是翻转后的值。
 *
 * 父级只需要把这个结果翻译成「当前选中值」：
 *
 * - 翻转后为 **选中**：用户选了这一项 → 更新选中值；
 * - 翻转后为 **未选中**：用户点的是本来就选中的那一项。单选组不该出现「一个都没选」，
 *   所以要把它**拨回选中**（`pin: true`），并保持选中值不变。
 *
 * 之所以不自己维护选中态、只跟随组件：组件的 handleClick 无法被外部阻止（除非在
 * `beforeinput` 里 preventDefault），让组件管状态、父级管语义，路径最短也最不容易漏。
 */
export function resolveChipToggle(
  current: string | number,
  clicked: string | number,
  selectedAfterToggle: boolean,
): { picked: string | number; pin: boolean } {
  if (selectedAfterToggle) return { picked: clicked, pin: false };
  // 点的是已选中项：组件把它翻掉了，需拨回
  return { picked: current, pin: true };
}
