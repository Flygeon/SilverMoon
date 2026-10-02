/**
 * 空降助手的播放器侧接线：自动跳过 + 进度条标记。
 *
 * 参考实现：hanydd/BilibiliSponsorBlock `src/content/skipScheduler.ts`（跳过调度）
 * 与 `skipUIManager.ts`（进度条标记）。这里按桌面端单播放器的形态简化：
 * - 跳过调度直接挂在 ArtPlayer 的 `video:timeupdate` 上（原项目要跨 iframe 通信）；
 * - 进度条标记用 ArtPlayer 自带的 `highlight` 能力，不自己画 DOM。
 *
 * ## 为什么「只跳一次」要单独记
 * 用户可能主动把进度拖回广告段里（比如想看看讲了什么）。若无记忆，下一次
 * timeupdate 会立刻把他再弹走 —— 表现为「拖回去又被踢出来」，非常恼人。
 * 所以每条片段跳过一次就记下来，之后不再自动触发。
 */
import { computed, watch, type Ref } from "vue";
import { SB_CATEGORY_MAP, findActiveSkip, skipTargets, skippedKey } from "@/utils/sponsorBlock";

interface ArtLike {
  currentTime: number;
  duration: number;
  on: (evt: string, fn: () => void) => void;
  off: (evt: string, fn: () => void) => void;
  seek: number;
}

export interface SponsorSkipOptions {
  enabled: Ref<boolean>;
  categories: Ref<Record<string, boolean>>;
  /** 是否提示「已跳过」 */
  toast: Ref<boolean>;
  /** store 里拉到的片段 */
  segments: Ref<SbSegment[]>;
  /** 已跳过集合 */
  skipped: Ref<Set<string>>;
  markSkipped: (key: string) => void;
  /** 跳过时通知 UI（toast） */
  onSkipped: (s: SbSegment) => void;
  /** 当前分 P，用于判断片段是否属于本段 */
  activeCid: Ref<string>;
}

import type { SbSegment } from "@/utils/sponsorBlock";

export function useSponsorSkip(opts: SponsorSkipOptions) {
  let art: ArtLike | null = null;

  /** 当前生效的待跳片段（按用户勾选的分类过滤）。 */
  const targets = computed(() =>
    skipTargets(opts.segments.value, opts.categories.value).filter(
      (s) => !opts.activeCid.value || !s.cid || s.cid === opts.activeCid.value,
    ),
  );

  /**
   * 进度条标记。
   *
   * ArtPlayer 的 `highlight` 接受 `{ time, text }` 列表，渲染成进度条上的彩色刻痕，
   * 悬浮显示 text。用它比自绘 DOM 稳（全屏切换、进度条重排都由 ArtPlayer 负责）。
   */
  const highlights = computed(() =>
    targets.value.map((s) => {
      const meta = SB_CATEGORY_MAP[s.category];
      return {
        time: s.start,
        text: `${meta?.short ?? s.category} ${fmt(s.start)} - ${fmt(s.end)}`,
      };
    }),
  );

  /** 主循环：播放位置刷新时判断是否进入待跳片段。 */
  function tick(): void {
    if (!art || !opts.enabled.value) return;
    const t = art.currentTime;
    if (!Number.isFinite(t)) return;
    const hit = findActiveSkip(targets.value, t);
    if (!hit) return;
    const key = skippedKey(hit);
    // 已跳过的不再自动触发：用户可能主动拖回片段内查看
    if (opts.skipped.value.has(key)) return;
    opts.markSkipped(key);
    // 跳到片段末尾。`full` 类不会进来（skipTargets 已排除 start==end）
    const to = Math.min(hit.end, Number.isFinite(art.duration) ? art.duration : hit.end);
    try {
      art.seek = to;
    } catch {
      // 播放器切换窗口内 seek 可能失败：忽略，下一帧还会再判
    }
    if (opts.toast.value) opts.onSkipped(hit);
  }

  function attach(player: ArtLike | null): void {
    if (art) art.off("video:timeupdate", tick);
    art = player;
    if (art) art.on("video:timeupdate", tick);
  }

  function detach(): void {
    attach(null);
  }

  // 开关关掉时不再尝试跳过（已在飞的 tick 会因为 enabled 为假直接返回）
  watch(
    () => opts.enabled.value,
    (on) => {
      if (!on) return;
      tick();
    },
  );

  return { attach, detach, targets, highlights };
}

/** 秒 → mm:ss（进度条 tooltip 用）。 */
function fmt(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, "0")}`;
}
