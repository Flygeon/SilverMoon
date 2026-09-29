/**
 * 虚拟 <audio>：把解码与输出交给 Flutter 侧的 just_audio。
 *
 * 前端（stores/player.ts）会 new Audio() 并依赖一整套 HTMLMediaElement 行为：
 * 读 currentTime 驱动逐字歌词、监听 timeupdate/ended 推进队列、写 currentTime
 * 拖动进度。桌面端这些由浏览器实现，移动端如果继续用真实元素，
 * 息屏后音频会停、通知栏和锁屏没有控制。
 *
 * 所以这里用一个只实现**被用到的那部分**的替身，把命令转发给 Flutter，
 * 再把 Flutter 的状态回灌成 DOM 事件。前端的播放逻辑一行都不用改。
 *
 * 通道：
 *   出站  { kind: "audio", op, ... } 经 window.SMNative 交给 Flutter
 *   入站  silvermoon:native 事件里 name === "audio:event"
 *        复用既有的 Dart → JS 事件通道，不再开第二条路径
 */
export {};

interface AudioInbound {
  type?: string;
  currentTime?: number;
  duration?: number;
  message?: string;
}

function post(msg: Record<string, unknown>): void {
  const n = window.SMNative ?? window.__SM_NATIVE__;
  if (!n || typeof n.postMessage !== "function") return;
  try {
    n.postMessage(JSON.stringify({ kind: "audio", ...msg }));
  } catch {
    // 通道还没就绪就丢弃：音频命令全部发生在用户操作之后，此时通道必然已建立
  }
}

/** 当前活跃的替身实例。同一时刻只会有一个全局 <audio>（由 player store 持有）。 */
let live: NativeAudio | null = null;

class NativeAudio extends EventTarget {
  // 这两个属性前端会写，但移动端没有对应语义，收下即可
  preload = "auto";
  crossOrigin: string | null = null;

  private _src = "";
  /** Flutter 最近一次上报的播放位置（秒） */
  private _base = 0;
  /** 收到该位置时的 performance.now() */
  private _at = 0;
  private _duration = NaN;
  private _paused = true;
  private _rate = 1;
  private _volume = 1;
  /** 拖动中的目标位置；非 null 时 currentTime 直接返回它 */
  private _seeking: number | null = null;

  constructor() {
    super();
    live = this;
  }

  get src(): string {
    return this._src;
  }

  set src(v: string) {
    // 只记录，不触发加载：前端紧接着会显式调用 load()
    this._src = v ? new URL(v, location.href).href : "";
  }

  /**
   * 读的时候在 Flutter 最近一次上报之上做线性外推。
   * LyricsView 用 rAF 直接读它做逐字高亮，只靠 100ms 一次的上报会一顿一顿。
   */
  get currentTime(): number {
    if (this._seeking !== null) return this._seeking;
    if (this._paused) return this._base;
    const elapsed = (performance.now() - this._at) / 1000;
    const t = this._base + elapsed * this._rate;
    return this._duration > 0 ? Math.min(t, this._duration) : t;
  }

  set currentTime(v: number) {
    const t = Number(v);
    if (!Number.isFinite(t) || t < 0) return;
    this._seeking = t;
    this._base = t;
    this._at = performance.now();
    post({ op: "seek", time: t });
    // 不等 Flutter 回包就回 seeked：进度条要立刻停在手指松开的位置
    queueMicrotask(() => {
      this._seeking = null;
      this.dispatchEvent(new Event("seeked"));
    });
  }

  get duration(): number {
    return this._duration;
  }

  get paused(): boolean {
    return this._paused;
  }

  get volume(): number {
    return this._volume;
  }

  set volume(v: number) {
    this._volume = Number(v);
    post({ op: "volume", value: this._volume });
  }

  get playbackRate(): number {
    return this._rate;
  }

  set playbackRate(v: number) {
    this._rate = Number(v) || 1;
    post({ op: "rate", value: this._rate });
  }

  play(): Promise<void> {
    if (!this._src) return Promise.reject(new Error("no src"));
    post({ op: "play", src: this._src });
    // 立刻置位，避免前端在 play() 的 await 之前读到 paused === true 而误判
    this._at = performance.now();
    this._paused = false;
    return Promise.resolve();
  }

  pause(): void {
    post({ op: "pause" });
  }

  load(): void {
    post({ op: "load", src: this._src });
  }

  canPlayType(): string {
    return "probably";
  }

  removeAttribute(name: string): void {
    if (name !== "src") return;
    this._src = "";
    post({ op: "load", src: "" });
  }

  setAttribute(name: string, value: string): void {
    if (name === "src") this.src = value;
  }

  getAttribute(name: string): string | null {
    return name === "src" ? this._src || null : null;
  }

  /** Flutter → 这里。把状态变化还原成 DOM 事件。 */
  __handle(msg: AudioInbound): void {
    switch (msg.type) {
      case "loadedmetadata":
        this._duration = Number(msg.duration ?? NaN);
        this._base = 0;
        this._at = performance.now();
        this.dispatchEvent(new Event("loadedmetadata"));
        this.dispatchEvent(new Event("durationchange"));
        this.dispatchEvent(new Event("canplay"));
        break;
      case "timeupdate":
        this._base = Number(msg.currentTime ?? 0);
        this._at = performance.now();
        this.dispatchEvent(new Event("timeupdate"));
        break;
      case "play":
        this._at = performance.now();
        this._paused = false;
        this.dispatchEvent(new Event("play"));
        this.dispatchEvent(new Event("playing"));
        break;
      case "pause": {
        // 先按仍在播的状态算出冻结位置，再置 paused
        const t = this.currentTime;
        this._base = t;
        this._at = performance.now();
        this._paused = true;
        this.dispatchEvent(new Event("pause"));
        break;
      }
      case "ended":
        this._base = this._duration > 0 ? this._duration : this.currentTime;
        this._paused = true;
        this.dispatchEvent(new Event("ended"));
        break;
      case "error":
        this._paused = true;
        this.dispatchEvent(new Event("error"));
        break;
      default:
        break;
    }
  }
}

// ------------------------------------------------------------ 安装

window.addEventListener("silvermoon:native", (e: Event) => {
  const detail = (e as CustomEvent).detail as
    | { name?: string; payload?: AudioInbound }
    | undefined;
  if (detail?.name !== "audio:event" || !detail.payload) return;
  live?.__handle(detail.payload);
});

(window as unknown as { Audio: unknown }).Audio = NativeAudio;

// 注意：**不**去 patch AudioContext.createMediaElementSource。
// 前端 utils/audioEffects.ts 会拿它接 Web Audio 音效链，而替身不是真正的
// HTMLMediaElement，原生实现必然抛 TypeError —— 这正是想要的结果：
// stores/audioEffects.ts 的 catch 会把 enabled 置 false，音效开关诚实关闭，
// 而不是留一个滑杆能动、声音毫无变化的假 UI。
// 移动端的均衡器由 just_audio 的 AndroidEqualizer 承担，见 player_service.dart。