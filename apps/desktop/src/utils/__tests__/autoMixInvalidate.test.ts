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
/**
 * AutoMix 预载歌词的接线护栏（源码级）。
 *
 * 纯逻辑测不到「接线」：prefetchCloudLyrics 写得再对，只要没接进 doPrepareNext，
 * 用户感知到的仍然是「切过去才去搜歌词」。所以这里直接读源码断言调用点与顺序约束。
 */
describe("AutoMix 预载歌词（接线护栏）", () => {
  const src = readFileSync(resolve(__dirname, "../../stores/player.ts"), "utf8");

  it("预载流程里会顺带预载下一曲歌词", () => {
    expect(src).toContain("prefetchNextLyrics(");
  });

  it("歌词预载与分析并行，而不是排在后面（否则白等一轮）", () => {
    const idx = src.indexOf("const [curAnalysis, nextAnalysis] = await Promise.all([");
    expect(idx).toBeGreaterThan(-1);
    // 同一个 Promise.all 的三个成员：当前曲分析 / 下一曲分析 / 歌词预载
    const body = src.slice(idx, idx + 320);
    expect(body).toContain("analyze(cur.source");
    expect(body).toContain("analyzeNextItem(item, src)");
    expect(body).toContain("prefetchNextLyrics(item, src, preloadEl)");
  });

  it("预载发生在 prepared 落位之前（这样失败也只是跳过，不会污染过渡状态）", () => {
    const callAt = src.indexOf("prefetchNextLyrics(item, src, preloadEl)");
    const assignAt = src.indexOf("prepared = { index: idx, analysis: nextAnalysis, src }");
    expect(callAt).toBeGreaterThan(-1);
    expect(assignAt).toBeGreaterThan(callAt);
  });

  it("关闭「更精确的逐字歌词」时不预载（不白花流量）", () => {
    const fnAt = src.indexOf("async function prefetchNextLyrics(");
    expect(fnAt).toBeGreaterThan(-1);
    const body = src.slice(fnAt, fnAt + 600);
    expect(body).toMatch(/if \(!s\.preciseLyrics\) return;/);
  });

  it("拿不到时长就跳过预载（±1s 匹配依赖它，宁可不做也不误配）", () => {
    expect(src).toMatch(/if \(!meta\.durationMs\) \{[\s\S]{0,120}return;/);
  });

  it("在线 / WebDAV 的时长读的是预载元素，而不是当前正在播的元素", () => {
    // waitAudioDuration 必须能收元素参数，且预载路径传的是 el
    expect(src).toMatch(
      /function waitAudioDuration\(\s*timeoutMs: number,\s*el: HTMLAudioElement \| null = audioEl\.value,/,
    );
    expect(src).toContain("await waitAudioDuration(3000, el)");
  });

  it("预载元素由 AutoMix 的双 deck 提供，且只在真正会用 AutoMix 时才创建", () => {
    const fnAt = src.indexOf("function ensureDualDeck(");
    const body = src.slice(fnAt, fnAt + 600);
    expect(body).toContain("preloadEl = dualDeck.other(mixDeck.value).el");
  });

  it("预载失败静默降级：不弹提示、不写 lastError", () => {
    const fnAt = src.indexOf("async function prefetchNextLyrics(");
    const body = src.slice(fnAt, src.indexOf("function prefetchWebdavLyrics("));
    expect(body).toMatch(/catch \(e\) \{[\s\S]{0,200}mixWarn\(/);
    expect(body).not.toContain("showLyricNotice");
    expect(body).not.toContain("lastError");
  });

  it("预载的下一曲失效时，预载元素上的源也要断掉", () => {
    const fnAt = src.indexOf("function invalidatePrepared(");
    const body = src.slice(fnAt, fnAt + 900);
    expect(body).toContain("preloadEl.removeAttribute");
  });

  it("过渡时源没变就不重挂（保住预载阶段已经缓冲好的数据）", () => {
    expect(src).toMatch(/if \(to\.el\.src !== prepared\.src \|\| to\.el\.readyState === 0\) \{/);
  });

  it("挂源时跳过正在播的元素（否则会把当前曲打断）", () => {
    const fnAt = src.indexOf("function primePreloadSource(");
    expect(fnAt).toBeGreaterThan(-1);
    const body = src.slice(fnAt, fnAt + 400);
    expect(body).toContain("el === audioEl.value");
    // 当前元素腾出来后，预载元素要跟着换，否则下一次预载会落到正在播的 deck 上
    expect(src).toContain("preloadEl = oldEl;");
  });
});
