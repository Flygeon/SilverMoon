import { describe, expect, it } from "vitest";
import { masonryLayout, mediaAspect } from "../mediaLayout";
import type { MediaEntry } from "@shared/types";
const entry = (id: number, type: MediaEntry["type"], width?: number, height?: number) =>
  ({ id: String(id), type, width, height }) as MediaEntry;
describe("mixed media masonry", () => {
  it("uses media cover proportions and bounds extreme images", () => {
    expect(mediaAspect(entry(0, "audio", 1920, 1080))).toBe(1);
    expect(mediaAspect(entry(0, "book"))).toBeCloseTo(2 / 3);
    expect(mediaAspect(entry(0, "video"))).toBeCloseTo(16 / 9);
    expect(mediaAspect(entry(0, "image", 800, 1200))).toBeCloseTo(2 / 3);
    expect(mediaAspect(entry(0, "image", 10, 10000))).toBe(0.4);
  });
  it("fills the shortest column rather than leaving empty rows", () => {
    const { cells } = masonryLayout([entry(0, "book"), entry(1, "video"), entry(2, "audio")], 432);
    expect(cells[2].left).toBe(cells[1].left);
    expect(cells[2].top).toBe(cells[1].height + 16);
  });
  it.each([180, 432, 900, 1400])(
    "keeps 1000 mixed cards in bounds without overlaps at %i pixels",
    (width) => {
      const items = Array.from({ length: 1000 }, (_, i) =>
        entry(i, ["book", "video", "audio", "image"][i % 4] as MediaEntry["type"]),
      );
      const { cells, cellWidth, height } = masonryLayout(items, width);
      const bottoms = new Map<number, number>();
      for (const cell of cells) {
        expect(cell.left + cellWidth).toBeLessThanOrEqual(width + 0.01);
        expect(cell.top).toBeGreaterThanOrEqual(bottoms.get(cell.left) ?? 0);
        bottoms.set(cell.left, cell.top + cell.height);
      }
      expect(height).toBe(Math.max(...bottoms.values()));
    },
  );
  it("handles empty and unmeasured layouts", () => {
    expect(masonryLayout([], 0).height).toBe(0);
    expect(masonryLayout([entry(0, "audio")], 0).cellWidth).toBe(0);
  });
  it("removes metadata space from cover-only masonry", () => {
    const { cells, cellWidth, height } = masonryLayout(
      [entry(0, "audio"), entry(1, "audio")],
      200,
      200,
      0,
    );
    expect(cells[0].height).toBe(cellWidth);
    expect(cells[1].top).toBe(cellWidth + 16);
    expect(height).toBe(cellWidth * 2 + 16);
  });
});
