/**
 * Web Audio 音效引擎。
 *
 * 说明：
 * - 使用 `createMediaElementSource` 把全局 `<audio>` 接入 AudioContext。
 * - 节点链：source → input → EQ/低音增强 → 混响 → 立体声宽度 → output → destination。
 * - 关闭音效时不会销毁节点（同一个 media element 只能创建一次 source），
 *   而是切换到 bypass 直通路径，保证以后还能无损重新开启。
 * - 只有用户首次开启音效时才创建 AudioContext；未开启时保持原生直通播放，
 *   避免 Web Audio 对跨域/本地协议的未知影响。
 */
import type { AudioEffectConfig, EqBand } from "@shared/types";

/** 默认 10 段 EQ 频点 */
export const DEFAULT_EQ_BANDS: EqBand[] = [
  { frequency: 31, gain: 0 },
  { frequency: 62, gain: 0 },
  { frequency: 125, gain: 0 },
  { frequency: 250, gain: 0 },
  { frequency: 500, gain: 0 },
  { frequency: 1000, gain: 0 },
  { frequency: 2000, gain: 0 },
  { frequency: 4000, gain: 0 },
  { frequency: 8000, gain: 0 },
  { frequency: 16000, gain: 0 },
];

/**
 * 10 段 EQ 的滤波器 Q。
 *
 * 频点 31…16000 是**严格一个倍频程**一个。相邻 peaking 滤波器在 1 倍频程间距下，
 * 要让各段交叠处的合成响应尽量平坦，Q 应取 √2 ≈ 1.414；此前取 1 会让每段更窄，
 * 段与段之间出现波纹（听感上是某些频段「塌下去」）。
 */
const EQ_Q = Math.SQRT2;
const REVERB_SECONDS = 1.8;
const REVERB_DECAY = 3;

export class AudioEffectEngine {
  private ctx: AudioContext | null = null;
  private media: HTMLAudioElement | null = null;

  private input: GainNode | null = null;
  private output: GainNode | null = null;
  private bypass: GainNode | null = null;
  private effectMix: GainNode | null = null;

  private eqFilters: BiquadFilterNode[] = [];
  private bassFilter: BiquadFilterNode | null = null;

  private dryGain: GainNode | null = null;
  private wetGain: GainNode | null = null;
  private convolver: ConvolverNode | null = null;

  /** 主元素的专用增益（AutoMix 淡入用）；未接入时为 null */
  private primaryGain: GainNode | null = null;

  /**
   * 响度归一化增益节点。
   *
   * 与 `primaryGain` 串联：primaryGain(自动混音淡入) → loudnessGain(响度归一化) → input。
   * 这样两个功能互不干扰：自动混音控制"这歌怎么进来"，响度归一化控制"它多响"。
   *
   * 未 attach 时为 null，此时 setLoudnessGain 只是记下值，等 attach 后生效。
   */
  private loudnessGain: GainNode | null = null;
  private loudnessGainValue = 1;

  /** 额外接入的 media 元素（双 deck 的第二个 deck） */
  private extraSources: {
    media: HTMLAudioElement;
    source: MediaElementAudioSourceNode;
    gain: GainNode;
  }[] = [];

  private widthGains: {
    lOut0: GainNode;
    lOut1: GainNode;
    rOut0: GainNode;
    rOut1: GainNode;
  } | null = null;

  get attached(): boolean {
    return this.ctx !== null;
  }

  attach(media: HTMLAudioElement): void {
    if (this.ctx) return;
    const Ctx: typeof AudioContext =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new Ctx();
    const source = ctx.createMediaElementSource(media);
    const input = ctx.createGain();
    const output = ctx.createGain();
    const bypass = ctx.createGain();
    const effectMix = ctx.createGain();
    /**
     * 主元素专用增益，插在 source 与 input 之间。
     *
     * AutoMix 需要能**单独淡入当前曲**而不影响其他 deck。默认恒为 1，
     * 因此不开启 AutoMix 时它等于不存在（信号乘以 1）。
     */
    const primaryGain = ctx.createGain();
    primaryGain.gain.value = 1;

    // 响度归一化增益：接在 primaryGain 之后、input 之前（见字段注释）
    const loudGain = ctx.createGain();
    loudGain.gain.value = this.loudnessGainValue;

    source.connect(primaryGain);
    primaryGain.connect(loudGain);
    loudGain.connect(input);
    input.connect(bypass);
    bypass.connect(output);

    /**
     * 末端限幅器。
     *
     * 整条链路此前**没有任何限幅**，而有三个环节都在抬高峰值：
     * EQ 各段提升、低音增强、以及立体声加宽（100% 时增益矩阵是
     * [[1.5, -0.5], [-0.5, 1.5]]，单侧峰值可达 1.5×）。
     * 三者叠加越 0 dBFS 就是硬削波，表现为破音。这里用低阈值 + 高比例兜底，
     * 正常电平下几乎不介入（knee = 0，阈值 -1.5 dBFS）。
     */
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -1.5;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.1;
    output.connect(limiter);
    limiter.connect(ctx.destination);

    // EQ 链
    let prev: AudioNode = input;
    for (const band of DEFAULT_EQ_BANDS) {
      const filter = ctx.createBiquadFilter();
      filter.type =
        band.frequency === DEFAULT_EQ_BANDS[0].frequency
          ? "lowshelf"
          : band.frequency === DEFAULT_EQ_BANDS[DEFAULT_EQ_BANDS.length - 1].frequency
            ? "highshelf"
            : "peaking";
      filter.frequency.value = band.frequency;
      filter.Q.value = EQ_Q;
      filter.gain.value = band.gain;
      prev.connect(filter);
      prev = filter;
      this.eqFilters.push(filter);
    }

    /**
     * 低音增强：独立的 120 Hz low shelf。
     *
     * 注意这里与 EQ 的第 0 段（31 Hz，同为 `lowshelf`）**是两级串联的 shelf**，
     * 所以「低音增强」和「31 Hz 滑块」在低频上会相互叠加。
     * 之所以保留这个拓扑：两者语义确实不同（一个是用户滑块、一个是快捷增强），
     * 且 bassBoost 默认 0；改成单一 shelf 会静默改变已有用户预设的听感。
     * 真要收敛，应作为一次带听感评估的独立改动，而不是顺手重构。
     */
    const bass = ctx.createBiquadFilter();
    bass.type = "lowshelf";
    bass.frequency.value = 120;
    bass.gain.value = 0;
    prev.connect(bass);

    const dry = ctx.createGain();
    const wet = ctx.createGain();
    const convolver = ctx.createConvolver();
    convolver.buffer = this.makeImpulse(ctx, REVERB_SECONDS, REVERB_DECAY);
    bass.connect(dry);
    bass.connect(convolver);
    convolver.connect(wet);

    const sum = ctx.createGain();
    dry.connect(sum);
    wet.connect(sum);

    // 立体声宽度（mid/side 简易实现）
    const splitter = ctx.createChannelSplitter(2);
    const merger = ctx.createChannelMerger(2);
    const lOut0 = ctx.createGain();
    const lOut1 = ctx.createGain();
    const rOut0 = ctx.createGain();
    const rOut1 = ctx.createGain();
    sum.connect(splitter);
    splitter.connect(lOut0, 0, 0);
    splitter.connect(lOut1, 0, 0);
    splitter.connect(rOut0, 1, 0);
    splitter.connect(rOut1, 1, 0);
    lOut0.connect(merger, 0, 0);
    lOut1.connect(merger, 0, 1);
    rOut0.connect(merger, 0, 0);
    rOut1.connect(merger, 0, 1);
    merger.connect(effectMix);
    effectMix.connect(output);

    this.ctx = ctx;
    this.media = media;
    this.primaryGain = primaryGain;
    this.loudnessGain = loudGain;
    this.input = input;
    this.output = output;
    this.bypass = bypass;
    this.effectMix = effectMix;
    this.bassFilter = bass;
    this.dryGain = dry;
    this.wetGain = wet;
    this.convolver = convolver;
    this.widthGains = { lOut0, lOut1, rOut0, rOut1 };
  }

  /**
   * 把**第二个** media element 接进同一条音效链（AutoMix 双 deck 用）。
   *
   * 为什么需要单独一个方法：`createMediaElementSource` 对同一个元素只能调用一次，
   * 所以第二个 deck 必须建自己的 source 节点。这里只建 source + 一个增益，
   * 然后接到既有的 `input` 上 —— EQ / 混响 / 宽度等下游节点完全不动，
   * 因此「双 deck 接入」不会改变任何音效行为。
   *
   * 返回该 deck 的增益节点，供 AutoMix 做交叉淡化；
   * 若音效链尚未建立，返回 null（调用方退回 element.volume）。
   */
  attachAdditional(media: HTMLAudioElement): GainNode | null {
    if (!this.ctx || !this.input) return null;
    // 幂等：同一元素只能建一次 MediaElementSource（重复会抛 InvalidStateError）。
    // AutoMix 会「接管」已被音效链接入的主元素，必须走这条复用分支而不是新建。
    if (this.media === media) return this.primaryGain;
    const existing = this.extraSources.find((s) => s.media === media);
    if (existing) return existing.gain;
    const source = this.ctx.createMediaElementSource(media);
    const gain = this.ctx.createGain();
    gain.gain.value = 1;
    source.connect(gain);
    gain.connect(this.input);
    this.extraSources.push({ media, source, gain });
    return gain;
  }

  /**
   * 设置响度归一化增益（线性倍率，1 = 不改动）。
   *
   * 在音效关闭时也有效：只要引擎已 attach 就起作用；未 attach 则先记下取值，
   * 等下次 attach 时应用 —— 这样「响度归一化」不依赖「音效开关」，
   * 两者是彼此独立的两个功能。
   */
  setLoudnessGain(value: number): void {
    this.loudnessGainValue = Number.isFinite(value) && value > 0 ? value : 1;
    if (this.loudnessGain && this.ctx) {
      this.loudnessGain.gain.setTargetAtTime(this.loudnessGainValue, this.ctx.currentTime, 0.05);
    }
  }

  /** 当前响度增益（供 UI 显示）。 */
  getLoudnessGain(): number {
    return this.loudnessGainValue;
  }

  /**
   * 主元素的专用增益。AutoMix 用它淡入当前曲；未接 Web Audio 时返回 null，
   * 调用方退回 element.volume。
   */
  getPrimaryGain(): GainNode | null {
    return this.primaryGain;
  }

  /** 某元素是否已接入（避免重复 createMediaElementSource 抛错）。 */
  hasSource(media: HTMLAudioElement): boolean {
    if (this.media === media) return true;
    return this.extraSources.some((s) => s.media === media);
  }

  update(config: AudioEffectConfig): void {
    if (!this.ctx) return;

    // 启用/旁通
    if (this.bypass && this.effectMix) {
      this.bypass.gain.value = config.enabled ? 0 : 1;
      this.effectMix.gain.value = config.enabled ? 1 : 0;
    }

    // EQ
    config.eqBands.forEach((band, i) => {
      this.eqFilters[i]?.gain.setTargetAtTime(band.gain, this.ctx!.currentTime, 0.03);
    });

    // 低音增强
    this.bassFilter?.gain.setTargetAtTime(config.bassBoost, this.ctx.currentTime, 0.03);

    // 混响干湿比（等功率交叉淡化）
    //
    // 此前是线性 `dry = 1-r, wet = r`。干湿两路在 `sum` 上是**相加**的，线性律在
    // 中点会让总能量抬起来（各 0.5），听感就是「混响开到一半声音反而变大、发糊」。
    // 等功率律保证 dry² + wet² = 1：一路降一路升，总功率恒定。
    const reverb = Math.max(0, Math.min(100, config.reverb));
    const theta = (reverb / 100) * (Math.PI / 2);
    const dryValue = Math.cos(theta);
    const wetValue = Math.sin(theta);
    this.dryGain?.gain.setTargetAtTime(dryValue, this.ctx.currentTime, 0.03);
    this.wetGain?.gain.setTargetAtTime(wetValue, this.ctx.currentTime, 0.03);

    // 立体声宽度：0=单声道，50=原始，100=加宽
    const width = Math.max(0, Math.min(100, config.stereoWidth)) / 100;
    const factor = width * 2;
    const gLL = (1 + factor) / 2;
    const gLR = (1 - factor) / 2;
    const gRL = (1 - factor) / 2;
    const gRR = (1 + factor) / 2;
    if (this.widthGains) {
      this.widthGains.lOut0.gain.setTargetAtTime(gLL, this.ctx.currentTime, 0.03);
      this.widthGains.lOut1.gain.setTargetAtTime(gLR, this.ctx.currentTime, 0.03);
      this.widthGains.rOut0.gain.setTargetAtTime(gRL, this.ctx.currentTime, 0.03);
      this.widthGains.rOut1.gain.setTargetAtTime(gRR, this.ctx.currentTime, 0.03);
    }
  }

  resume(): void {
    if (this.ctx && this.ctx.state === "suspended") {
      void this.ctx.resume().catch(() => {});
    }
  }

  suspend(): void {
    if (this.ctx && this.ctx.state === "running") {
      void this.ctx.suspend().catch(() => {});
    }
  }

  private makeImpulse(ctx: AudioContext, seconds: number, decay: number): AudioBuffer {
    const length = Math.max(1, Math.floor(ctx.sampleRate * seconds));
    const buffer = ctx.createBuffer(2, length, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const data = buffer.getChannelData(ch);
      for (let i = 0; i < length; i++) {
        const t = i / length;
        data[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, decay);
      }
    }
    return buffer;
  }
}

/** 全局单例音效引擎 */
export const audioEffectEngine = new AudioEffectEngine();
