/**
 * 双 deck 管理器：两个 audio 元素轮流当「当前曲」与「下一曲」。
 *
 * 设计要点：
 *
 * 1. **惰性创建**。只有真正要混音时才建第二个 deck；不用 AutoMix 的用户
 *    只有一个 audio 元素，行为与改造前完全一致（零回归面）。
 * 2. **淡化走哪条路**。接了 Web Audio 就用 GainNode（能精确做等功率曲线）；
 *    没接就退回 element.volume。两条路的听感有细微差异，但都可用。
 * 3. **主动 deck 不归本类管**。哪个 deck 是「当前曲」是 player store 的概念，
 *    这里只提供「另一个 deck」和淡化原语，避免状态重复。
 */
import { equalPowerGains, type DeckId } from "./autoMix";
import type { AudioEffectEngine } from "./audioEffects";

export interface DeckHandle {
  readonly id: DeckId;
  readonly el: HTMLAudioElement;
  /** Web Audio 增益；为 null 表示未接入，淡化走 element.volume */
  gain: GainNode | null;
  /**
   * 是否已挂过状态同步监听。
   *
   * deck 会被反复复用（A/B 轮流当「当前曲」），而 bindElement 是追加式的；
   * 不加这个标记会在第二次复用时把监听挂两遍，导致 timeupdate 里
   * 进度上报与歌词更新各跑两次。
   */
  listenersBound: boolean;
}

/**
 * 双 deck 管理器。
 *
 * 用法：
 *   const decks = new DualDeck(engine);
 *   const other = decks.other(activeId);   // 拿另一个 deck，预载下一曲
 *   decks.crossfade(active, other, 8000);  // 8 秒等功率交叉
 */
export class DualDeck {
  private engine: AudioEffectEngine;
  private decks = new Map<DeckId, DeckHandle>();
  private log: (msg: string, detail?: unknown) => void;

  constructor(engine: AudioEffectEngine, log: (msg: string, detail?: unknown) => void = () => {}) {
    this.engine = engine;
    this.log = log;
  }

  /** 取（必要时创建）某个 deck。 */
  get(id: DeckId): DeckHandle {
    const existing = this.decks.get(id);
    if (existing) return existing;

    const el = new Audio();
    el.preload = "auto";
    // 跨域音频接入 Web Audio 后会变静音，必须显式声明 anonymous
    el.crossOrigin = "anonymous";
    // 增益链接管后，element.volume 就不要再动了（两处同时控制会打架）
    const gain = this.engine.attachAdditional(el);
    const handle: DeckHandle = { id, el, gain, listenersBound: false };
    this.decks.set(id, handle);
    this.log(`deck ${id} 已创建`, { routed: !!gain });
    return handle;
  }

  /**
   * 找出某个 audio 元素对应的 deck。
   *
   * 用于「deck 提升」：过渡结束后 audioEl 会指向另一个元素，
   * 下一次过渡时不能再用固定的 "a"/"b"，必须按元素反查。
   * 主元素（外部传入的、未由本类创建的那个）不在 decks 里，返回 null，
   * 调用方据此回退到 mixDeck 记录的 id。
   */
  deckFor(el: HTMLAudioElement): DeckHandle | null {
    for (const d of this.decks.values()) {
      if (d.el === el) return d;
    }
    return null;
  }

  /** 把一个已存在的元素注册为某个 deck（用于把主 audio 纳入管理）。 */
  adopt(id: DeckId, el: HTMLAudioElement): DeckHandle {
    const existing = this.decks.get(id);
    if (existing) return existing;
    const gain = this.engine.attachAdditional(el);
    const handle: DeckHandle = { id, el, gain, listenersBound: false };
    this.decks.set(id, handle);
    this.log(`deck ${id} 已接管既有元素`, { routed: !!gain });
    return handle;
  }

  /** 给定一个 deck，返回另一个。 */
  other(id: DeckId): DeckHandle {
    return this.get(id === "a" ? "b" : "a");
  }

  /**
   * 尝试把 deck 接入 Web Audio（音效链可能晚于 deck 创建才就绪）。
   * 返回是否已接入。
   */
  tryRoute(deck: DeckHandle): boolean {
    if (deck.gain) return true;
    if (!this.engine.attached) return false;
    // attachAdditional 是幂等的：元素已接入时会直接返回它既有的增益
    const g = this.engine.attachAdditional(deck.el);
    if (!g) return false;
    deck.gain = g;
    this.log(`deck ${deck.id} 已接入音效链`, undefined);
    return true;
  }

  /** 设置单个 deck 的增益（0~1）。 */
  setGain(deck: DeckHandle, value: number): void {
    const v = Math.max(0, Math.min(1, value));
    if (deck.gain) deck.gain.gain.value = v;
    else deck.el.volume = v;
  }

  /**
   * 交叉淡化：在 `durationMs` 内把 from 降到 0、to 升到 1。
   *
   * 用 rAF 逐帧写增益（而不是 Web Audio 的线性 ramp），因为：
   * - 等功率曲线不是线性的，用 linearRamp 得不到正确形状；
   * - 未接 Web Audio 时也要能工作（此时只能写 element.volume）。
   * 60fps 下每帧不到 0.1% 的增益变化，不会有可闻的阶梯感。
   *
   * 返回一个可 await 的 Promise，在淡化结束时 resolve。
   */
  crossfade(
    from: DeckHandle,
    to: DeckHandle,
    durationMs: number,
    onTick?: (t: number) => void,
  ): Promise<void> {
    const dur = Math.max(1, durationMs);
    const start = performance.now();
    this.log("交叉淡化开始", { from: from.id, to: to.id, durationMs: dur });

    return new Promise((resolve) => {
      const step = () => {
        const elapsed = performance.now() - start;
        const t = Math.min(1, elapsed / dur);
        const g = equalPowerGains(t);
        this.setGain(from, g.a);
        this.setGain(to, g.b);
        onTick?.(t);
        if (t >= 1) {
          this.setGain(from, 0);
          this.setGain(to, 1);
          this.log("交叉淡化结束", { elapsedMs: Math.round(elapsed) });
          resolve();
          return;
        }
        requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    });
  }

  /** 立即把某 deck 静音（用于过渡被中断、或用户手动切歌）。 */
  silence(id: DeckId): void {
    const d = this.decks.get(id);
    if (d) this.setGain(d, 0);
  }

  /** 释放所有 deck。 */
  dispose(): void {
    for (const d of this.decks.values()) {
      try {
        d.el.pause();
        d.el.removeAttribute("src");
        d.el.load();
      } catch {
        /* 忽略 */
      }
    }
    this.decks.clear();
  }
}
