import { describe, expect, it, vi } from "vitest";
import { mseMime, parseByteRange, parseSidx } from "@/utils/biliDash";
import type { BiliStream } from "@/utils/bilibili";

// biliDash 顶部引 @/capabilities：纯浏览器环境下它会在导入期读 location
vi.mock("@/capabilities", () => ({ isDesktop: false, capabilities: {} }));

/** 手工拼一个最小可用的 sidx 盒（version 0，reference_type=0）。 */
function buildSidx(entries: { size: number; duration: number }[], timescale = 16000): Uint8Array {
  const headerSize = 12; // size + type + version/flags
  const fixed = 4 + 4 + 8 + 2 + 2; // ref_ID + timescale + ept/first_offset + reserved + count
  const boxSize = headerSize + fixed + entries.length * 12;
  const buf = new Uint8Array(boxSize);
  const view = new DataView(buf.buffer);
  view.setUint32(0, boxSize);
  buf.set([0x73, 0x69, 0x64, 0x78], 4); // 'sidx'
  buf[8] = 0; // version 0
  view.setUint32(12, 1); // reference_ID
  view.setUint32(16, timescale);
  view.setUint32(20, 0); // earliest_presentation_time
  view.setUint32(24, 0); // first_offset
  view.setUint16(28, 0); // reserved
  view.setUint16(30, entries.length);
  let p = 32;
  for (const e of entries) {
    // reference_type 置 0（媒体），大小放低 31 位
    view.setUint32(p, e.size & 0x7fffffff);
    view.setUint32(p + 4, e.duration);
    view.setUint32(p + 8, 0x90000000); // starts_with_SAP
    p += 12;
  }
  return buf;
}

describe("parseByteRange", () => {
  it("解析标准的 start-end 区间", () => {
    expect(parseByteRange("0-1008")).toEqual({ start: 0, end: 1008 });
    expect(parseByteRange("1545-2000")).toEqual({ start: 1545, end: 2000 });
  });

  it("非法输入返回 null", () => {
    expect(parseByteRange("")).toBeNull();
    expect(parseByteRange("abc")).toBeNull();
    expect(parseByteRange("100-50")).toBeNull();
  });
});

describe("parseSidx", () => {
  it("解出分片表，且首片紧跟在 sidx 盒之后", () => {
    const idxRangeStart = 1009;
    const entries = [
      { size: 1000, duration: 16000 }, // 1s @16000
      { size: 2000, duration: 32000 }, // 2s
    ];
    const bytes = buildSidx(entries);
    const parsed = parseSidx(bytes, idxRangeStart);

    expect(parsed).not.toBeNull();
    expect(parsed!.timescale).toBe(16000);
    expect(parsed!.segments).toEqual([
      // anchor = 1009 + boxSize(=12+20+24=56) = 1065
      { start: 1065, end: 2064, startTime: 0, duration: 1 },
      { start: 2065, end: 4064, startTime: 1, duration: 2 },
    ]);
  });

  it("空引用表返回空分片（调用方据此判定解析失败）", () => {
    const parsed = parseSidx(buildSidx([]), 0);
    expect(parsed).not.toBeNull();
    expect(parsed!.segments).toHaveLength(0);
  });

  it("没有 sidx 盒时返回 null", () => {
    expect(parseSidx(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]), 0)).toBeNull();
  });

  it("timescale 为 0 时视为非法", () => {
    expect(parseSidx(buildSidx([{ size: 10, duration: 10 }], 0), 0)).toBeNull();
  });
});

describe("mseMime", () => {
  const base: BiliStream = {
    id: 80,
    url: "https://example.com/v.mp4",
    backupUrls: [],
    codecs: "avc1.640032",
    width: 1920,
    height: 1080,
    bandwidth: 100,
    initRange: "0-1008",
    indexRange: "1009-1544",
    mimeType: "video/mp4",
  };

  it("带上 codecs 参数", () => {
    expect(mseMime(base, "video/mp4")).toBe('video/mp4; codecs="avc1.640032"');
  });

  it("缺少 codecs 时退回裸 MIME", () => {
    expect(mseMime({ ...base, codecs: "" }, "video/mp4")).toBe("video/mp4");
  });

  it("mimeType 缺失时使用兜底值", () => {
    expect(mseMime({ ...base, mimeType: "" }, "audio/mp4")).toBe('audio/mp4; codecs="avc1.640032"');
  });
});
