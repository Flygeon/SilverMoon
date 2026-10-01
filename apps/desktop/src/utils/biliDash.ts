/**
 * B 站 DASH（MSE）取流引擎。
 *
 * ## 为什么需要它
 *
 * B 站的 `playurl` 有两条通道：`fnval=1`（渐进式 MP4 / durl）与 `fnval=16/4048`
 * （DASH）。上游在渐进式通道上**把清晰度钳死在 720P**：即便带登录凭据请求
 * `qn=80/112/116`，返回的 `accept_quality` 也只剩 `[64,16]`（1080P 及以上的
 * durl 根本不生成）。720P 以上的 DASH 分片必须由播放端自行合流，而 `<video src>`
 * 不能直接吃 DASH，故这里用 MSE（MediaSource）把「视频轨 + 音频轨」拼给同一个
 * `<video>` 元素。
 *
 * ## 取流方式
 *
 * B 站把每路流切成一堆 fMP4 分片，分片索引（sidx）单独一个小段返回：
 *
 * ```text
 * ftyp | free | free | moov | sidx | moof+mdat | moof+mdat | ...
 * ^^^^^ 初始化段 ^^^^^  ^^^^ 索引段 ^^^^  ^^^^^^^^^ 媒体分片 ^^^^^^^^^
 * ```
 *
 * 因此流程是：拉初始化段喂给 `SourceBuffer` → 拉索引段自己解出每个分片的
 * 「字节区间 + 起始时间」→ 按播放进度用 `Range` 逐片拉取并 append。
 * `sidx` 结构简单（见 `parseSidx`），直接手解即可，不必为此引入 demuxer 依赖。
 *
 * ## 为什么走宿主通道而不是渲染进程 fetch
 *
 * B 站的视频 CDN 是 PCDN，域名形如 `*.edge.mountaintoys.cn` / `*.bilivideo.com`，
 * 且**要求 `Referer: https://www.bilibili.com`**。主进程的 webRequest 改写只覆盖
 * 白名单域名（见 `electron/net-headers.ts`），PCDN 域名不在其中；而宿主网络通道
 * 可以显式带上 `Referer` / `Range`，与域名无关，最稳。
 */
import { isDesktop } from "@/capabilities";
import type { BiliStream } from "@/utils/bilibili";

/** 一个 DASH 媒体分片（字节闭区间 + 时间轴区间，单位秒）。 */
export interface DashSegment {
  start: number;
  end: number;
  startTime: number;
  duration: number;
}

/** `"1234-5678"` → 字节区间；非法返回 null。 */
export function parseByteRange(s: string): { start: number; end: number } | null {
  const m = /^(\d+)-(\d+)$/.exec(s.trim());
  if (!m) return null;
  const start = Number(m[1]);
  const end = Number(m[2]);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  return { start, end };
}

/**
 * 解析 `sidx`（Segment Index Box）里的分片引用。
 *
 * 布局（ISO/IEC 14496-12 §8.16.3）：
 * ```text
 * [size(4)] sidx(4) version(1) flags(3) reference_ID(4) timescale(4)
 *   earliest_presentation_time(4|8) first_offset(4|8) reserved(2)
 *   reference_count(2) then {type+size(4), duration(4), sap(4)} * count
 * ```
 *
 * 分片字节位置不是绝对偏移：第一个分片紧跟在 **sidx 盒之后**（`anchor`），
 * 之后依次累加。`first_offset` 一般是 0；若非 0 需要额外加上（本处按规范累加）。
 */
export function parseSidx(
  bytes: Uint8Array,
  baseOffset = 0,
): { timescale: number; segments: DashSegment[] } | null {
  const buf = bytes;
  // 定位 'sidx' 四字节类型码
  let typeAt = -1;
  for (let i = 0; i + 4 <= buf.length; i++) {
    if (buf[i] === 0x73 && buf[i + 1] === 0x69 && buf[i + 2] === 0x64 && buf[i + 3] === 0x78) {
      typeAt = i;
      break;
    }
  }
  if (typeAt < 4) return null;
  const boxStart = typeAt - 4;
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const boxSize = view.getUint32(boxStart);
  const version = buf[boxStart + 8];
  let p = boxStart + 12; // size + type + version/flags
  p += 4; // reference_ID
  const timescale = view.getUint32(p);
  p += 4;
  p += version === 0 ? 8 : 16; // earliest_presentation_time + first_offset
  p += 2; // reserved
  const count = view.getUint16(p);
  p += 2;
  if (!timescale) return null;

  const segments: DashSegment[] = [];
  let pos = baseOffset + boxStart + boxSize;
  let t = 0;
  for (let i = 0; i < count && p + 12 <= buf.length; i++) {
    const w = view.getUint32(p);
    p += 4;
    const refType = (w >>> 31) & 1;
    const size = w & 0x7fffffff;
    const dur = view.getUint32(p);
    p += 4;
    p += 4; // SAP 信息
    if (size <= 0) continue;
    const seconds = dur / timescale;
    // 只有媒体引用（type=0）才是可 append 的分片；层级索引跳过
    if (refType === 0) {
      segments.push({ start: pos, end: pos + size - 1, startTime: t, duration: seconds });
      t += seconds;
    }
    pos += size;
  }
  return { timescale, segments };
}

/** 拉取字节区间。宿主通道可显式带 Referer，且不受 CDN 域名白名单限制。 */
export async function fetchRange(
  url: string,
  start: number,
  end: number,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const headers: Record<string, string> = {
    Range: `bytes=${start}-${end}`,
    Referer: "https://www.bilibili.com",
    Origin: "https://www.bilibili.com",
  };
  if (isDesktop) {
    const mod = await import("@/ipc/http");
    const res = await mod.fetch(url, { headers, signal });
    if (!res.ok && res.status !== 206) throw new Error(`DASH 分片请求失败：HTTP ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  }
  const res = await fetch(url, { headers, signal });
  if (!res.ok && res.status !== 206) throw new Error(`DASH 分片请求失败：HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

/** 由上游字段拼出 MSE 的 `SourceBuffer` MIME。 */
export function mseMime(track: BiliStream, fallback: "video/mp4" | "audio/mp4"): string {
  const mime = track.mimeType || fallback;
  return track.codecs ? `${mime}; codecs="${track.codecs}"` : mime;
}

/** 时间 `t` 落在第几个分片里（返回该分片下标；`t` 超过最后一片则返回最后一片）。 */
export function segmentIndexAt(segments: DashSegment[], t: number): number {
  let i = 0;
  while (i + 1 < segments.length && segments[i + 1].startTime <= t) i++;
  return i;
}

/**
 * `t` 是否已落在某段缓冲区内（`evict` 之后 buffered 通常是多段的）。
 *
 * 容差 0.5s：`timeupdate` 的采样点与分片边界不会严格对齐。
 */
export function isTimeBuffered(buffered: TimeRanges, t: number): boolean {
  for (let i = 0; i < buffered.length; i++) {
    if (t >= buffered.start(i) - 0.5 && t <= buffered.end(i) + 0.5) return true;
  }
  return false;
}

/** 单路轨道（视频或音频）的拉取 / 喂给 `SourceBuffer` 状态机。 */
class TrackFeeder {
  /** 下一个待拉取的分片下标（测试需要断言，故为包可见） */
  next = 0;
  private appending = false;
  private pending = false;
  private aborted = false;
  private stopped = false;
  /** 连续重试计数（成功后清零），仅在拉取内部使用 */
  private retries = 0;
  /** 本轨道全部喂完时回调（由会话注入） */
  onDrained?: () => void;
  /** 提前缓冲的秒数：太小容易卡顿，太大则白拉流量 */
  private readonly ahead: number;

  constructor(
    readonly sb: SourceBuffer,
    private readonly segments: DashSegment[],
    private readonly url: string,
    private readonly getTime: () => number,
    ahead: number,
    private readonly onError: (e: unknown) => void,
    /** 会话级 signal：destroy() 时能真正取消在途分片请求 */
    private readonly signal?: AbortSignal,
  ) {
    this.ahead = ahead;
    this.sb.addEventListener("updateend", this.onUpdateEnd);
    this.sb.addEventListener("error", this.onSbError);
  }

  /**
   * 一次 append 结束后立刻评估是否还要继续缓冲。
   *
   * 这里**不**只在有 pending 标记时才继续：`timeupdate` 每 250ms 才来一次，
   * 若一次只喂一个分片，30s 的缓冲目标要十几秒才填满，中途一遇到网络抖动就卡。
   * 改为「append 结束 → 再看一眼水位」链式推进，到目标水位自然停。
   */
  private onUpdateEnd = (): void => {
    this.appending = false;
    this.pending = false;
    void this.pump();
  };

  private onSbError = (): void => {
    this.onError(new Error("SourceBuffer 追加失败（编码不受支持或数据损坏）"));
  };

  /** 把游标对齐到时间 `t` 所在（或之前最近）的分片，供跳转 / 起播定位。 */
  seekTo(t: number): void {
    this.next = segmentIndexAt(this.segments, t);
  }

  /**
   * 目标播放位置没有数据时，把游标回退到该位置重新拉。
   *
   * `next` 只向前推进，而 `evict` 会丢弃播放点之前的旧分片；用户往回拖进度条
   * （或某片拉取失败留下空洞）之后，目标位置就没有数据了，必须回退游标回填，
   * 否则播放会卡在空洞上。
   *
   * ⚠️ 判据必须是「**该位置是否已缓冲**」，不能写成「t 是否落在缓冲区中段」——
   * 中段恰恰是已经有数据的地方，那种写法会在**每次 timeupdate** 都把游标拽回
   * 播放点，造成反复重拉同一批分片（表现为播放抖动、流量翻倍）。
   */
  resync(t: number): void {
    // 有 append / fetch 在途时不能重定位：此刻 buffered 还没包含在途那一片，
    // 会把 next 拽回它，与 append 完成后的 next += 1 相互覆盖，同一片被反复拉取。
    if (this.appending || this.sb.updating) return;
    if (!isTimeBuffered(this.sb.buffered, t)) this.seekTo(t);
  }

  /** 已缓冲到的时间上限（没有缓冲返回 0）。 */
  bufferedEnd(): number {
    const b = this.sb.buffered;
    return b.length ? b.end(b.length - 1) : 0;
  }

  async pump(): Promise<void> {
    if (this.aborted || this.stopped) return;
    // SourceBuffer 同一时刻只允许一次 append；正在 fetching 或 updating 都算忙。
    // 少了 updating 这一判，旧 append 的 updateend 会抢在新 append 之前再进一次
    // pump，形成「AppendBuffer 时 InvalidStateError」。
    if (this.appending || this.sb.updating) {
      this.pending = true;
      return;
    }
    if (this.next >= this.segments.length) return;

    const t = this.getTime();
    // 缓冲已经足够靠前就歇着，等 timeupdate 再唤醒
    if (this.bufferedEnd() > t + this.ahead) return;

    const seg = this.segments[this.next];
    this.appending = true;
    this.pending = false;
    try {
      const bytes = await this.fetchWithRetry(seg);
      if (this.aborted || this.stopped) return;
      // appendBuffer 需要 ArrayBuffer；切片视图要按 offset 拷贝
      const copy = bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      ) as ArrayBuffer;
      this.sb.appendBuffer(copy);
      // appendBuffer 同步抛错时不计入 next，该分片下次还会重试
      this.next += 1;
      this.retries = 0;
      // 全部喂完 → 通知会话收尾（endOfStream / 自动下一 P）
      if (this.next >= this.segments.length) this.onDrained?.();
    } catch (e) {
      this.appending = false;
      // 被动中止（destroy / 切清晰度）不算错误
      if (this.aborted || this.stopped) return;
      this.onError(e);
    }
  }

  /**
   * 拉一片，失败时带退避重试。
   *
   * 单次网络抖动不该直接弹「视频流加载失败」覆盖层：原来一片失败就 onError 且
   * next 不前移，若播放器已进入 waiting 又没有新的 timeupdate，播放会永久停住。
   */
  private async fetchWithRetry(seg: DashSegment): Promise<Uint8Array> {
    const maxAttempts = 3;
    let lastError: unknown;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (this.aborted || this.stopped) throw new Error("已中止");
      try {
        return await fetchRange(this.url, seg.start, seg.end, this.signal);
      } catch (e) {
        lastError = e;
        // 退避 400ms / 1200ms，给 CDN 一点恢复时间
        await new Promise((r) => setTimeout(r, 400 * attempt + 400));
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  /** 缓冲区里最前面的可用时间，用于丢旧数据。 */
  bufferedStart(): number {
    const b = this.sb.buffered;
    return b.length ? b.start(0) : 0;
  }

  get finished(): boolean {
    return this.next >= this.segments.length;
  }

  /** 暂停推进（切清晰度前调用），已入队的分片仍可安全 append 完。 */
  stop(): void {
    this.stopped = true;
  }

  destroy(): void {
    this.aborted = true;
    this.stopped = true;
    this.sb.removeEventListener("updateend", this.onUpdateEnd);
    this.sb.removeEventListener("error", this.onSbError);
  }
}

export interface DashLoadOptions {
  video: BiliStream;
  audio: BiliStream | null;
  /** 起播位置（秒），用于从上次进度继续 */
  startTime?: number;
  /** 缓冲不足时的回调（调用方据此提示） */
  onError: (e: unknown) => void;
  /** 首个分片可播时回调 */
  onReady?: () => void;
  onProgress?: (bufferedEnd: number) => void;
  /** 播放点之前保留的缓冲秒数（默认 30） */
  keepBehindSeconds?: number;
  /** 已缓冲时长超过该值才回收（默认 90） */
  keepWindowSeconds?: number;
  /** 全部轨道喂完后回调（用来到点 endOfStream / 自动下一 P） */
  onEnded?: () => void;
}

/**
 * 把一路 B 站 DASH 音视频流接到一个 `<video>` 元素上。
 *
 * 生命周期：`load()` → 播放中持续 append → `destroy()`。切换清晰度时**新建一个
 * 实例**（`MediaSource` 不能复用），由调用方负责先 destroy 再 load。
 */
export class BiliDashSession {
  private media: MediaSource | null = null;
  private objectUrl = "";
  private feeders: TrackFeeder[] = [];
  private aborter: AbortController | null = null;
  private video: HTMLVideoElement | null = null;
  private opts: DashLoadOptions | null = null;
  private onTimeUpdate: (() => void) | null = null;
  private destroyed = false;
  /** 总时长（由视频轨 sidx 求和），用于给 MSE 一个确定的 duration */
  private duration = 0;
  /** MSE 只允许在 sourceopen 后创建 SourceBuffer；记录是否已就绪 */
  private sourceOpen = false;
  /** 播放点之前保留多少秒缓冲（超出部分可回收） */
  private keepBehind = 30;
  /** 已缓冲长度超过该值才触发回收，避免频繁 remove 卡顿 */
  private keepWindow = 90;

  /** 是否支持当前流（编码 / MSE 可用性）。 */
  static supported(track: BiliStream, fallback: "video/mp4" | "audio/mp4"): boolean {
    if (typeof MediaSource === "undefined") return false;
    const mime = mseMime(track, fallback);
    try {
      return MediaSource.isTypeSupported(mime);
    } catch {
      return false;
    }
  }

  /** DASH 是否能满足这次播放（视频必选、音频可选）。 */
  static canPlay(video: BiliStream, audio: BiliStream | null): boolean {
    if (!BiliDashSession.supported(video, "video/mp4")) return false;
    if (audio && !BiliDashSession.supported(audio, "audio/mp4")) return false;
    return true;
  }

  async load(videoEl: HTMLVideoElement, opts: DashLoadOptions): Promise<void> {
    this.video = videoEl;
    this.opts = opts;
    if (opts.keepBehindSeconds !== undefined) this.keepBehind = opts.keepBehindSeconds;
    if (opts.keepWindowSeconds !== undefined) this.keepWindow = opts.keepWindowSeconds;
    this.destroyed = false;
    this.aborter = new AbortController();
    const signal = this.aborter.signal;

    // 1) 拉两路的初始化段 + 索引段（并发）
    const [vInit, vIdx, aInit, aIdx] = await Promise.all([
      fetchRange(opts.video.url, ...rangePair(opts.video.initRange), signal),
      fetchRange(opts.video.url, ...rangePair(opts.video.indexRange), signal),
      opts.audio
        ? fetchRange(opts.audio.url, ...rangePair(opts.audio.initRange), signal)
        : Promise.resolve(null),
      opts.audio
        ? fetchRange(opts.audio.url, ...rangePair(opts.audio.indexRange), signal)
        : Promise.resolve(null),
    ]);
    if (this.destroyed) return;

    const vParsed = parseSidx(vIdx, parseByteRange(opts.video.indexRange)?.start ?? 0);
    if (!vParsed || !vParsed.segments.length) throw new Error("DASH 索引解析失败（未取到分片表）");
    this.duration = vParsed.segments.reduce((a, s) => a + s.duration, 0);

    const aParsed =
      aIdx && opts.audio
        ? parseSidx(aIdx, parseByteRange(opts.audio.indexRange)?.start ?? 0)
        : null;
    if (opts.audio && (!aParsed || !aParsed.segments.length)) {
      throw new Error("DASH 音频索引解析失败");
    }

    // 2) 建立 MediaSource
    const ms = new MediaSource();
    this.media = ms;
    this.objectUrl = URL.createObjectURL(ms);
    videoEl.src = this.objectUrl;

    await new Promise<void>((resolve, reject) => {
      // 极少数时序下 sourceopen 可能在挂监听前就已触发，先判一次 readyState
      if (ms.readyState === "open") {
        resolve();
        return;
      }
      // 超时兜底：若 videoEl.src 被后续 mountSource 覆盖，这个 MediaSource
      // 可能既不 open 也不 close，await 会永久挂起并泄漏整个 session。
      const timer = setTimeout(() => reject(new Error("MediaSource 打开超时")), 5000);
      const done = (fn: () => void) => {
        clearTimeout(timer);
        fn();
      };
      ms.addEventListener("sourceopen", () => done(resolve), { once: true });
      // 明确的失败路径：媒体源在打开前被关闭（例如元素被销毁）
      ms.addEventListener(
        "sourceclose",
        () => {
          if (ms.readyState !== "open") done(() => reject(new Error("MediaSource 已关闭")));
        },
        { once: true },
      );
    });
    if (this.destroyed) return;
    this.sourceOpen = true;
    ms.duration = this.duration || Number.POSITIVE_INFINITY;

    // 3) 创建 SourceBuffer 并喂初始化段
    const vSb = ms.addSourceBuffer(mseMime(opts.video, "video/mp4"));
    const aSb = opts.audio && aParsed ? ms.addSourceBuffer(mseMime(opts.audio, "audio/mp4")) : null;

    await appendInit(vSb, vInit);
    if (aSb && aInit) await appendInit(aSb, aInit);

    // 4) 启动两路 feeder
    const video = videoEl;
    const start = Math.max(0, opts.startTime ?? 0);
    const vFeeder = new TrackFeeder(
      vSb,
      vParsed.segments,
      opts.video.url,
      () => video.currentTime,
      30,
      opts.onError,
      signal,
    );
    vFeeder.seekTo(start);
    this.feeders.push(vFeeder);

    if (aSb && aParsed && opts.audio) {
      const aFeeder = new TrackFeeder(
        aSb,
        aParsed.segments,
        opts.audio.url,
        () => video.currentTime,
        30,
        opts.onError,
        signal,
      );
      aFeeder.seekTo(start);
      this.feeders.push(aFeeder);
    }

    // 两路都喂完 → endOfStream，让 <video> 触发 ended（否则播到片尾永远不停，
    // 「自动下一个分 P」也拿不到挂点）
    for (const feeder of this.feeders) {
      feeder.onDrained = () => this.maybeEndOfStream();
    }

    // 5) 播放位置驱动：timeupdate / seeking 时补数据；顺带做缓冲区回收
    this.onTimeUpdate = () => {
      const t = video.currentTime;
      for (const f of this.feeders) {
        f.resync(t);
        void f.pump();
      }
      opts.onProgress?.(vFeeder.bufferedEnd());
      this.evict();
    };
    video.addEventListener("timeupdate", this.onTimeUpdate);
    video.addEventListener("seeking", this.onTimeUpdate);
    video.addEventListener("waiting", this.onTimeUpdate);

    if (start > 0) {
      const seek = () => {
        try {
          video.currentTime = start;
        } catch {
          /* 元数据仍未就绪则忽略 */
        }
      };
      seek();
      // 元数据没就绪时上面的赋值会被静默丢弃（新 MediaSource 的 duration 要等
      // sidx 解析完），表现为偶发从 0 开始播。loadedmetadata 后再补一次。
      if (video.readyState < 1) video.addEventListener("loadedmetadata", seek, { once: true });
    }

    // 6) 先喂够起播所需的首批分片
    await Promise.all(this.feeders.map((f) => f.pump()));
    opts.onReady?.();
  }

  /**
   * 丢弃远离播放点的旧缓冲，避免长视频把内存 / 配额吃满。
   *
   * **必须两路都回收**。此前只处理 `feeders[0]`（视频），音频那条一路 append 到
   * 片尾：2 小时的视频音频能累积上百 MB，命中 Chromium 的单 SourceBuffer 配额后
   * `error` 事件触发、feeder 从此停摆，且回退重拉还会再撞 QuotaExceededError ——
   * 表现为长视频播到中途卡死且无法恢复。
   */
  private evict(): void {
    const v = this.video;
    if (!v) return;
    const keepFrom = Math.max(0, v.currentTime - this.keepBehind);
    for (const feeder of this.feeders) {
      const sb = feeder.sb;
      // SourceBuffer 同一时刻只能有一个操作在途
      if (sb.updating) continue;
      const b = sb.buffered;
      if (!b.length) continue;
      // 缓冲明显长于窗口才回收，避免频繁 remove 造成卡顿
      if (keepFrom - b.start(0) > this.keepWindow) {
        try {
          sb.remove(b.start(0), keepFrom);
        } catch {
          /* 正在更新则跳过，下次 timeupdate 再试 */
        }
      }
    }
  }

  /** 所有轨道都喂完了 → 收尾。只在 SourceBuffer 空闲时调用 endOfStream。 */
  private maybeEndOfStream(): void {
    if (this.destroyed || !this.sourceOpen) return;
    if (!this.feeders.length || !this.feeders.every((f) => f.finished)) return;
    const ms = this.media;
    if (!ms || ms.readyState !== "open") return;
    // 有 append 在途时 endOfStream 会抛 InvalidStateError
    if (this.feeders.some((f) => f.sb.updating)) return;
    try {
      ms.endOfStream();
      this.opts?.onEnded?.();
    } catch {
      /* 已 endOfStream 或状态不允许：忽略，下次 updateend 还会再试 */
    }
  }

  destroy(): void {
    this.destroyed = true;
    // 先让两路 feeder 停止推进，再 abort 在途请求，避免拆解中途还往已移除的
    // SourceBuffer 上 append
    for (const f of this.feeders) f.stop();
    this.aborter?.abort();
    this.aborter = null;
    const v = this.video;
    if (v && this.onTimeUpdate) {
      v.removeEventListener("timeupdate", this.onTimeUpdate);
      v.removeEventListener("seeking", this.onTimeUpdate);
      v.removeEventListener("waiting", this.onTimeUpdate);
    }
    this.onTimeUpdate = null;
    for (const f of this.feeders) f.destroy();
    this.feeders = [];
    const ms = this.media;
    if (ms && this.sourceOpen) {
      try {
        if (ms.readyState === "open") ms.endOfStream();
      } catch {
        /* 已关闭则忽略 */
      }
    }
    this.media = null;
    if (this.objectUrl) {
      URL.revokeObjectURL(this.objectUrl);
      this.objectUrl = "";
    }
    if (v) {
      try {
        v.removeAttribute("src");
        v.load();
      } catch {
        /* 拆解期忽略 */
      }
    }
    this.video = null;
  }
}

/** `"0-1008"` → `[0, 1008]`；缺失时给一个宽松兜底。 */
function rangePair(range: string): [number, number] {
  const parsed = parseByteRange(range);
  if (parsed) return [parsed.start, parsed.end];
  // 初始化段通常在前 2KB，索引段紧跟其后；兜底取前 8KB 让 sidx 能解出来
  return [0, 8191];
}

/** 把初始化段 append 进 SourceBuffer 并等它落地。 */
function appendInit(sb: SourceBuffer, bytes: Uint8Array): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onEnd = () => {
      sb.removeEventListener("updateend", onEnd);
      sb.removeEventListener("error", onErr);
      resolve();
    };
    const onErr = () => {
      sb.removeEventListener("updateend", onEnd);
      sb.removeEventListener("error", onErr);
      reject(new Error("初始化段追加失败"));
    };
    sb.addEventListener("updateend", onEnd);
    sb.addEventListener("error", onErr);
    try {
      sb.appendBuffer(
        bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
      );
    } catch (e) {
      sb.removeEventListener("updateend", onEnd);
      sb.removeEventListener("error", onErr);
      reject(e);
    }
  });
}
