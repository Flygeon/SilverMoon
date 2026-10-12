/**
 * 图层面板的文案。
 *
 * 为什么不进 shared/i18n.ts：本次任务的改动范围限定为
 * DrawingBoard.vue 与 features/drawing/，i18n 词条后续可整体搬入
 * shared/i18n.ts 的 draw 段（key 名已按 draw.* 取好，直接可用）。
 */
const TEXT: Record<string, { zh: string; en: string }> = {
  "draw.layers": { zh: "图层", en: "Layers" },
  "draw.layer": { zh: "图层", en: "Layer" },
  "draw.addLayer": { zh: "新建图层", en: "New layer" },
  "draw.deleteLayer": { zh: "删除图层", en: "Delete layer" },
  "draw.toggleLayer": { zh: "显示 / 隐藏", en: "Show / hide" },
  "draw.moveLayerUp": { zh: "上移一层", en: "Move up" },
  "draw.moveLayerDown": { zh: "下移一层", en: "Move down" },
  "draw.renameLayer": { zh: "重命名图层", en: "Rename layer" },
  "draw.cannotDeleteLastLayer": { zh: "至少保留一个图层", en: "Keep at least one layer" },
  "draw.layerNamePlaceholder": { zh: "图层名称", en: "Layer name" },
};

/** 与 translate() 同签名习惯：缺 key 时原样返回 key（方便排查漏配） */
export function layerText(lang: string, key: string): string {
  const entry = TEXT[key];
  if (!entry) return key;
  return lang === "en" ? entry.en : entry.zh;
}
