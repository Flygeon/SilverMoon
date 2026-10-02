import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 「预载的下一曲」失效逻辑的测试。
 *
 * 背景：AutoMix 会提前把下一曲准备好（analysis + src）并缓存在 prepared 里。
 * 但如果用户此时手动切歌、切随机模式、或改了队列，prepared.index 指向的
 * 就不再是真正会播的那首 —— 继续用会把另一首歌混进来。
 * 这类 bug 不会崩，只会「听起来像随机插入了别人的音乐」，最难查。
 */

/** 复刻 player store 里的失效语义 */
function makeState() {
  return {
    prepared: null as null | { index: number },
    mixTriggeredFor: null as string | null,
    log: [] as string[],
  };
}
type State = ReturnType<typeof makeState>;

function invalidatePrepared(s: State, reason: string) {
  if (!s.prepared) return;
  s.log.push("invalidate:" + reason);
  s.prepared = null;
  s.mixTriggeredFor = null;
}

/** 复刻 playFromQueue 的入口行为 */
function playFromQueue(s: State, index: number, opts: { skipStart?: boolean } = {}) {
  if (!opts.skipStart) invalidatePrepared(s, "切换曲目");
  s.prepared = null;
}

describe("预载的下一曲失效（防止混入错误的歌）", () => {
  it("用户手动切歌 → 预载失效", () => {
    const s = makeState();
    s.prepared = { index: 5 };
    s.mixTriggeredFor = "track-a";
    playFromQueue(s, 7);
    expect(s.prepared).toBeNull();
    expect(s.mixTriggeredFor).toBeNull();
  });

  it("AutoMix 自身的交接（skipStart）不能清理预载", () => {
    const s = makeState();
    s.prepared = { index: 5 };
    playFromQueue(s, 5, { skipStart: true });
    expect(s.log.filter((x) => x.startsWith("invalidate"))).toHaveLength(0);
  });

  it("切换随机模式 → 预载失效（随机序变了）", () => {
    const s = makeState();
    s.prepared = { index: 3 };
    s.mixTriggeredFor = "t";
    invalidatePrepared(s, "切换随机播放");
    expect(s.prepared).toBeNull();
    expect(s.mixTriggeredFor).toBeNull();
    expect(s.log).toContain("invalidate:切换随机播放");
  });

  it("切换循环模式 → 预载失效（off/all/one 改变下一首）", () => {
    const s = makeState();
    s.prepared = { index: 1 };
    invalidatePrepared(s, "切换循环模式");
    expect(s.prepared).toBeNull();
  });

  it("没有预载时失效是空操作（不写日志、不抛错）", () => {
    const s = makeState();
    expect(() => invalidatePrepared(s, "切换曲目")).not.toThrow();
    expect(s.log).toHaveLength(0);
  });

  it("去重标记同时被清 → 新歌的过渡窗口能重新触发", () => {
    const s = makeState();
    s.prepared = { index: 2 };
    s.mixTriggeredFor = "old-track";
    playFromQueue(s, 9);
    expect(s.mixTriggeredFor).toBeNull();
  });
});

/**
 * 结构性护栏。
 *
 * 上面几条测的是「失效语义」这个纯逻辑，但真正会出错的是**接线**：
 * invalidatePrepared 定义得再对，只要忘了在切歌 / 切模式处调用，bug 依旧存在，
 * 而纯逻辑测试对「忘了调用」完全无感。所以这里直接读源码断言调用点存在。
 */
describe("接线护栏（源码级）", () => {
  const src = readFileSync(resolve(__dirname, "../../stores/player.ts"), "utf8");

  it("定义了 invalidatePrepared", () => {
    expect(src).toMatch(/function invalidatePrepared\(/);
  });

  it("playFromQueue 在非 skipStart 时调用失效", () => {
    const idx = src.indexOf("async function playFromQueue(");
    expect(idx).toBeGreaterThan(-1);
    const body = src.slice(idx, idx + 700);
    expect(body).toMatch(/if \(!opts\.skipStart\) invalidatePrepared\(/);
  });

  it("切换随机播放与循环模式都会失效", () => {
    expect(src).toMatch(/invalidatePrepared\("切换随机播放"\)/);
    expect(src).toMatch(/invalidatePrepared\("切换循环模式"\)/);
  });

  it("setQueue 会失效（队列整体替换后旧预载无意义）", () => {
    const idx = src.indexOf("function setQueue(");
    expect(idx).toBeGreaterThan(-1);
    const body = src.slice(idx, idx + 400);
    expect(body).toMatch(/invalidatePrepared\(/);
  });
});
