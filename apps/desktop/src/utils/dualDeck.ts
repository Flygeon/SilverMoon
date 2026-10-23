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
    if (deck.gain) {
      /*
       * 必须先取消排程。
       *
       * Web Audio 的规格是：一旦参数上排了自动化事件（setValueCurveAtTime 等），
       * 直接给 `gain.value` 赋值只是改了「内在值」，**不会**改变实际生效的增益 ——
       * 事件还在跑，写进去的终值会被曲线盖掉。而 crossfade 在接 Web Audio 时
       * 正是用曲线推进的，收尾这里若不取消，就会出现「过渡结束了但增益还挂在
       * 曲线中段」，与后台卡住的表现一样（无声 / 音量不对）。
       *
       * 注意必须优先用 `cancelAndHoldAtTime`：`cancelScheduledValues(now)` 只删除
       * **开始时间 ≥ now** 的事件，对「已经开始、正在播放中」的曲线无效 —— 那种
       * 情况下随后的 `.value = v` 仍会被曲线盖掉。过渡中途被切歌时正是这个时序。
       */
      const param = deck.gain.gain;
      // 测试替身 / 未真正接入音频图时可能没有 context：取 0 兜底，
      // 后面的自动化取消逻辑会自然降级（typeof 判定 + try/catch）。
      const now = deck.gain.context?.currentTime ?? 0;
      try {
        if (typeof param.cancelAndHoldAtTime === "function") {
          param.cancelAndHoldAtTime(now);
        } else {
          param.cancelScheduledValues(now);
        }
      } catch {
        try {
          param.cancelScheduledValues(now);
        } catch {
          /* 老环境可能都不支持，忽略 */
        }
      }
      param.value = v;
    } else {
      deck.el.volume = v;
    }
  }

  /**
   * 交叉淡化：在 `durationMs` 内把 from 降到 0、to 升到 1。
   *
   * ## 为什么不能只靠 requestAnimationFrame（「后台无声」的根因）
   *
   * Chromium 在窗口最小化 / 被其他窗口遮挡（document.visibilityState 变成
   * "hidden"）时会**暂停 rAF**，并把 setTimeout/setInterval 节流到约 1 次/秒。
   * 旧实现整条过渡只跑在 rAF 上，于是窗口进后台时：
   *
   *   1. rAF 不再回调，增益停在「旧 deck ≈1、新 deck ≈0」或中途某个值；
   *   2. 过渡返回的 Promise 永不 resolve → player.ts 的 runMix 卡在 await 上，
   *      deck 提升（把 audioEl 切到新 deck）永远不发生，`mixing` 一直是 true；
   *   3. 旧 deck 播到曲尾自然停下（淡出点本来就定在曲尾），此时唯一还在播的
   *      新 deck 增益被卡在 0 → **完全无声**；
   *   4. 旧 deck 的 ended 事件又因为 `mixing` 为真被丢掉（player.ts 的闸门），
   *      没有任何兜底能把播放救回来；
   *   5. 切回前台后 rAF 恢复，第一帧用 performance.now() 算出的 t 已经 ≥1，
   *      直接把增益写成 0/1 并 resolve → 提升瞬间完成 → **声音回来**。
   *
   * 这就是「后台突然没声音、切回前台又恢复」的完整链条：不是音频解码停了，
   * 而是「谁该出声」的交接被节流卡在半路。
   *
   * ## 两条兜底路径（都不引入新依赖）
   *
   * - 接了 Web Audio（两个 deck 都有 GainNode）：把整条等功率曲线用
   *   `setValueCurveAtTime` 排到**音频线程**。之后主线程无论被怎么节流，
   *   淡化都按音频时钟精确推进，后台也不会听到阶梯感。
   * - 没接 Web Audio（只能写 element.volume）：rAF 与 setTimeout **双驱动**。
   *   时间基准是 performance.now() 而不是帧数 —— 后台 rAF 停了，setTimeout
   *   仍会被（节流后）执行，按真实经过时间把过渡送完，粒度粗一点但绝不卡死。
   *
   * 两条路最后都必须收敛到「from = 0、to = 1 且 Promise resolve」，
   * 不会留下「增益 0 却还在播」的 deck。
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

    return new Promise<void>((resolve) => {
      let settled = false;
      let rafId: number | null = null;
      let timerId: ReturnType<typeof setTimeout> | null = null;

      const clearPending = () => {
        if (rafId !== null) {
          // 测试 / 非浏览器环境可能没有 cancelAnimationFrame：没有 rAF 时
          // 也就不会产生 rafId，这里只是多一层防御。
          if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(rafId);
          rafId = null;
        }
        if (timerId !== null) {
          clearTimeout(timerId);
          timerId = null;
        }
      };

      /** 收尾：只做一次，写死终值并 resolve（幂等，兜底定时器可能晚到）。 */
      const settle = () => {
        if (settled) return;
        settled = true;
        clearPending();
        this.setGain(from, 0);
        this.setGain(to, 1);
        this.log("交叉淡化结束", { elapsedMs: Math.round(performance.now() - start) });
        resolve();
      };

      // 路径 A：曲线交给音频线程，主线程只负责到点收尾（声音不受节流影响）。
      if (this.scheduleCrossfadeCurves(from, to, dur)) {
        /*
         * 后台时这个定时器会被节流，最多晚 1 秒左右执行。这段时间里淡化照常在
         * 音频线程上进行、音乐照常出声，只是「deck 提升」晚一点 —— 不会再无声。
         */
        timerId = setTimeout(settle, dur + 40);
        return;
      }

      // 路径 B：只能写 element.volume，逐帧推进但由时间而非帧数决定进度。
      const step = () => {
        clearPending();
        if (settled) return;
        const elapsed = performance.now() - start;
        const t = Math.min(1, elapsed / dur);
        const g = equalPowerGains(t);
        this.setGain(from, g.a);
        this.setGain(to, g.b);
        onTick?.(t);
        if (t >= 1) {
          settle();
          return;
        }
        /*
         * 同时排 rAF 与 setTimeout，谁先到用谁：
         * - 前台：rAF 约 16ms 一次，与旧的逐帧写入完全相同（听感/音质不变）；
         * - 后台：rAF 被暂停，由 setTimeout 接手推进（隐藏页会被节流，但还会执行）。
         * 每次 step 开头都会取消另一个，所以任意时刻最多各挂一个回调。
         */
        if (typeof requestAnimationFrame === "function") {
          rafId = requestAnimationFrame(step);
        }
        timerId = setTimeout(step, 250);
      };
      step();
    });
  }

  /** 等功率曲线的采样点数：64 点在 8 秒过渡里每点约 125ms，线性插值后无可闻台阶。 */
  private static readonly CURVE_POINTS = 64;

  /**
   * 把等功率曲线排到音频线程（见 crossfade 的注释）。
   *
   * 返回 true 表示已经交给音频线程，主线程不必再逐帧写增益。
   * 失败（未接 Web Audio / 事件冲突 / 环境不支持）返回 false，调用方退回逐帧写入。
   */
  private scheduleCrossfadeCurves(from: DeckHandle, to: DeckHandle, durMs: number): boolean {
    const a = from.gain;
    const b = to.gain;
    // 两个 deck 必须挂在同一个 AudioContext 上，时间轴才对齐。
    // 未接音效链（或测试替身没有 context）时直接走逐帧路径。
    if (!a || !b || !a.context || !b.context || a.context !== b.context) return false;

    const ctx = a.context;
    const n = DualDeck.CURVE_POINTS;
    const curveA = new Float32Array(n);
    const curveB = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const g = equalPowerGains(i / (n - 1));
      curveA[i] = g.a;
      curveB[i] = g.b;
    }

    // 留 10ms 调度余量：startTime 若落在 currentTime 之后一点点，曲线起点才不会
    // 因为主线程抖动而被钳到「已经过去」，形状更准。
    const now = ctx.currentTime;
    const at = now + 0.01;
    const durationSec = durMs / 1000;
    try {
      for (const [param, curve] of [
        [a.gain, curveA],
        [b.gain, curveB],
      ] as const) {
        // 清掉残留自动化：setValueCurveAtTime 与已有事件的区间重叠会抛错。
        // 正在播放中的旧曲线要用 cancelAndHoldAtTime 才能停住（见 setGain）。
        try {
          if (typeof param.cancelAndHoldAtTime === "function") {
            param.cancelAndHoldAtTime(now);
          } else {
            param.cancelScheduledValues(now);
          }
        } catch {
          param.cancelScheduledValues(now);
        }
        param.setValueAtTime(curve[0], now);
        param.setValueCurveAtTime(curve, at, durationSec);
      }
      return true;
    } catch {
      // 排不上就退回逐帧写入（宁可粒度粗，也不能让过渡停住）
      return false;
    }
  }

  /** 立即把某 deck 静音（用于过渡被中断、或用户手动切歌）。 */
  silence(id: DeckId): void {
    const d = this.decks.get(id);
    if (d) this.setGain(d, 0);
  }

  /**
   * 彻底停掉某 deck：增益归零 + 暂停。
   *
   * 放弃一次过渡时必须用它而不是 `silence`：只把增益写成 0 会留下一个
   * 「音量 0 但仍在播」的元素 —— 它继续占用解码/网络，还会让下一次
   * 预载判断（primePreloadSource 的「正在播就不碰」）失效。
   */
  stop(id: DeckId): void {
    const d = this.decks.get(id);
    if (!d) return;
    this.setGain(d, 0);
    try {
      d.el.pause();
    } catch {
      /* 元素可能已被释放，忽略 */
    }
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
