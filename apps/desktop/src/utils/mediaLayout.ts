import type { MediaEntry } from "@shared/types";

export function mediaAspect(item: MediaEntry): number {
  if (item.type === "audio") return 1;
  if (item.type === "book") return 2 / 3;
  if (item.width && item.height && item.width > 0 && item.height > 0) {
    return Math.max(0.4, Math.min(2.5, item.width / item.height));
  }
  return item.type === "video" ? 16 / 9 : 3 / 2;
}

/** Shortest-column placement preserves input order without creating blank grid rows. */
export function masonryLayout(items: MediaEntry[], width: number, minWidth = 200, metaHeight = 54) {
  const gap = 16;
  const columns = Math.max(1, Math.floor((width + gap) / (minWidth + gap)));
  const cellWidth = Math.max(0, (width - gap * (columns - 1)) / columns);
  const heights = Array<number>(columns).fill(0);
  const cells = items.map((item, index) => {
    const column = heights.indexOf(Math.min(...heights));
    const height = cellWidth / mediaAspect(item) + metaHeight;
    const cell = { item, index, left: column * (cellWidth + gap), top: heights[column], height };
    heights[column] += height + gap;
    return cell;
  });
  return { cells, cellWidth, height: Math.max(0, ...heights) - (items.length ? gap : 0) };
}
