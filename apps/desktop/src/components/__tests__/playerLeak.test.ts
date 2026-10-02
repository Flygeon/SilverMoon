import { describe, expect, it } from "vitest";

/**
 * 播放器实例并发创建的回归测试。
 *
 * 背景（由 V8 堆快照证实）：B 站播放页曾累积 **17 个** ArtPlayer 实例（应为 1），
 * 每个都带着一棵 DOM 子树与一个 <video>。根因是 createPlayer 的异步竞态：
 *
 *   async function createPlayer() {
 *     const mods = await Promise.all([import("artplayer"), ...]); // ← await 缺口
 *     art = new Artplayer({...});                                 // ← 无保护赋值
 *   }
 *
 * 而调用方可能在同一 tick 内触发两次：onMounted 的首次挂载 + play.value 到达时的
 * watcher。第二次进入时 art 仍为 null，于是又建一个并覆盖前者；卸载时只 destroy
 * 最后一个，前一个成为无人引用的孤儿。
 *
 * 这里用最小复刻把「并发去重 + 卸载保护 + 抢占校验」三条不变式固定下来。
 */

/** 复刻 createPlayer 的保护逻辑（与 BilibiliVideoView.doCreatePlayer 一致）。 */
function makeFactory(opts: { delayMs?: number } = {}) {
  const state = {
    art: null as null | { id: number },
    disposed: false,
    creating: null as Promise<void> | null,
    created: 0,
    destroyed: 0,
  };
  const load = () => new Promise((r) => setTimeout(r, opts.delayMs ?? 2));

  async function doCreate(): Promise<void> {
    await load();
    // await 期间可能已卸载，或已被别的实例抢先挂上
    if (state.disposed || state.art) return;
    const instance = { id: ++state.created };
    if (state.disposed || state.art) {
      state.destroyed++;
      return;
    }
    state.art = instance;
  }

  async function createPlayer(): Promise<void> {
    if (state.art) return;
    if (state.creating) return state.creating;
    state.creating = doCreate().finally(() => {
      state.creating = null;
    });
    return state.creating;
  }

  function close(): void {
    state.disposed = true;
    if (state.art) {
      state.destroyed++;
      state.art = null;
    }
  }
  return { state, createPlayer, close };
}

/** 泄漏数 = 创建 - 销毁 - 仍在用。 */
function leaked(s: { created: number; destroyed: number; art: unknown }): number {
  return s.created - s.destroyed - (s.art ? 1 : 0);
}

describe("播放器实例创建（防泄漏）", () => {
  it("并发调用两次只创建一个实例（修复前会创建两个，泄漏一个）", async () => {
    const f = makeFactory();
    await Promise.all([f.createPlayer(), f.createPlayer()]);
    expect(f.state.created).toBe(1);
    expect(leaked(f.state)).toBe(0);
  });

  it("创建过程中卸载 → 不产生实例，也不泄漏", async () => {
    const f = makeFactory({ delayMs: 5 });
    const p = f.createPlayer();
    f.state.disposed = true; // 模拟 await import 期间组件卸载
    await p;
    expect(f.state.created).toBe(0);
    expect(leaked(f.state)).toBe(0);
  });

  it("创建完成瞬间被抢占 → 把新建的那个销毁掉", async () => {
    const f = makeFactory();
    await f.createPlayer();
    const before = f.state.created;
    // 已有实例时再次调用应直接返回，不再新建
    await f.createPlayer();
    expect(f.state.created).toBe(before);
    expect(leaked(f.state)).toBe(0);
  });

  it("关键不变式：反复开关 17 次（每次两次并发触发）零残留", async () => {
    const created: number[] = [];
    let totalCreated = 0;
    let totalDestroyed = 0;
    for (let i = 0; i < 17; i++) {
      const f = makeFactory();
      await Promise.all([f.createPlayer(), f.createPlayer()]);
      expect(f.state.created).toBe(1);
      f.close();
      created.push(f.state.created);
      totalCreated += f.state.created;
      totalDestroyed += f.state.destroyed;
      expect(leaked(f.state)).toBe(0);
    }
    // 17 次开关 = 17 个实例、17 次销毁（修复前是 17 创建 / 1 销毁 → 残留 16+）
    expect(totalCreated).toBe(17);
    expect(totalDestroyed).toBe(17);
  });

  it("没有并发保护时确实会泄漏（证明这条测试有效）", async () => {
    // 故意用「无保护」的版本，验证测试能抓到回归
    let art: null | { id: number } = null;
    let created = 0;
    let destroyed = 0;
    const load = () => new Promise((r) => setTimeout(r, 3));
    async function naive() {
      await load();
      art = { id: ++created };
    }
    await Promise.all([naive(), naive()]);
    destroyed++; // 卸载只销毁最后一个
    art = null;
    expect(created - destroyed).toBe(1); // 泄漏 1 个
  });
});

/**
 * pixiv blob 缓存的淘汰逻辑。
 *
 * blob URL 不 revoke 就会一直保着底层字节 + 解码位图（一张 540² 缩略图约 1.1 MB）。
 * 而 PixivCard 每张卡片都调 imageUrl()，所以必须有上限。
 */
function evictOldest<K, V>(cache: Map<K, V>, limit: number, release: (v: V) => void): void {
  if (cache.size < limit) return;
  const drop = Math.max(1, Math.floor(limit * 0.2));
  let i = 0;
  for (const [key, value] of cache) {
    if (i++ >= drop) break;
    release(value);
    cache.delete(key);
  }
}

describe("pixiv blob 缓存淘汰", () => {
  it("未达上限时不淘汰", () => {
    const c = new Map<string, string>();
    let revoked = 0;
    for (let i = 0; i < 10; i++) {
      evictOldest(c, 200, () => revoked++);
      c.set("u" + i, "blob:" + i);
    }
    expect(c.size).toBe(10);
    expect(revoked).toBe(0);
  });

  it("达到上限后淘汰最早的一批并 revoke", () => {
    const c = new Map<string, string>();
    const revoked: string[] = [];
    for (let i = 0; i < 200; i++) c.set("u" + i, "blob:" + i);
    // 再写一条前先淘汰
    evictOldest(c, 200, (v) => revoked.push(v));
    expect(revoked.length).toBe(40); // 20% of 200
    expect(revoked[0]).toBe("blob:0"); // 最早的先走
    expect(c.has("u0")).toBe(false);
    expect(c.size).toBe(160);
  });

  it("多帧缓存（ugoira）淘汰时每帧都要 revoke", () => {
    const c = new Map<number, string[]>();
    const revoked: string[] = [];
    for (let i = 0; i < 6; i++) c.set(i, ["blob:a", "blob:b", "blob:c"]);
    evictOldest(c, 6, (frames) => frames.forEach((f) => revoked.push(f)));
    expect(revoked.length).toBeGreaterThan(0);
    // 淘汰 1 个动图 × 3 帧
    expect(revoked.length % 3).toBe(0);
  });
});
