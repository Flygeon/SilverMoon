/**
 * 宿主开放的**具名插槽**清单（前端侧镜像）。
 *
 * ⚠️ 这份列表与 Rust 侧 `commands/extension.rs` 的 `SLOT_IDS` **必须一致** ——
 * 两侧各存一份是因为：Rust 在**安装时**校验（写错直接拒绝），前端据此**渲染**。
 * 任何一侧加了插槽而另一侧忘了，表现就是「装得上但看不到」，很难查。
 * 所以这里有《插槽一致性》自检（scripts 里那条），比对本文件与 Rust 常量。
 */
export const EXT_SLOT_IDS = [
  "settings.sidebar",
  "settings.appearance",
  "settings.playback",
  "settings.library",
  "settings.online",
  "settings.system",
  "treasure.tools",
] as const;

export type ExtSlotId = (typeof EXT_SLOT_IDS)[number];
