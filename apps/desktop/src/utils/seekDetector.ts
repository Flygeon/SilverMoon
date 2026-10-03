/**
 * 跳转检测（对齐 AMLL 的 SeekDetector 语义）。
 *
 * 正常播放时媒体时钟与「物理时钟」同步推进；一旦两者偏差超阈值，或时间倒退，
 * 就说明发生了 seek。判定结果用于把滚动切到慢速弹簧 —— 用户拖进度条时希望
 * 看清落点，而不是继承普通切行的急促节奏。
 *
 * 与 AMLL（packages/core/src/lyric-player/base/seek-detector.ts）一致：
 * 倒退**无条件**判跳转；暂停时期望推进量为 0。
 */

/** 判定为跳转的时间偏差阈值（秒） */
const SEEK_THRESHOLD_SEC = 0.3;

export class SeekDetector {
  /** 上一次的媒体时间 */
  private lastMediaTime = 0;
  /** 上一次的物理时钟 */
  private lastWallClock = 0;
  private started = false;

  /**
   * 用当前媒体时间与物理时钟判定本帧是否为跳转。
   *
   * @param mediaTime 当前播放位置（秒）
   * @param isPlaying 播放器是否在播放（暂停时期望推进为 0）
   * @param now 物理时钟（毫秒，默认取 performance.now / Date.now）
   */
  detect(mediaTime: number, isPlaying: boolean, now = Date.now()): boolean {
    if (!this.started) {
      this.started = true;
      this.lastMediaTime = mediaTime;
      this.lastWallClock = now;
      return false;
    }

    const wallDelta = Math.max(0, (now - this.lastWallClock) / 1000);
    const expected = isPlaying ? wallDelta : 0;
    const actual = mediaTime - this.lastMediaTime;

    this.lastMediaTime = mediaTime;
    this.lastWallClock = now;

    // 倒退一定是跳转（正常播放不会倒退）
    if (actual < 0) return true;
    return Math.abs(actual - expected) > SEEK_THRESHOLD_SEC;
  }

  /** 重置基线（换歌时调用，避免把「新歌从 0 开始」误判成倒退跳转） */
  reset(mediaTime = 0, now = Date.now()): void {
    this.started = true;
    this.lastMediaTime = mediaTime;
    this.lastWallClock = now;
  }
}
