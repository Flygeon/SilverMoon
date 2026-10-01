<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from "vue";
import { usePlayerStore } from "@/stores/player";
import { useSettingsStore } from "@/stores/settings";
import { useNeteaseStore } from "@/stores/netease";
import { useRouter } from "vue-router";
import { translate } from "@shared/i18n";
import { useWindowDrag } from "@/composables/useWindowDrag";
import FluidBackground from "@/components/FluidBackground.vue";
import LyricsView from "@/components/LyricsView.vue";
import PlayerControlIcon from "@/components/PlayerControlIcon.vue";
import AudioEffectsPanel from "@/components/AudioEffectsPanel.vue";
import CommentsPanel from "@/components/CommentsPanel.vue";
import { formatDuration } from "@/utils/format";

const player = usePlayerStore();
const settings = useSettingsStore();
const netease = useNeteaseStore();
const router = useRouter();
const rightTab = ref<"lyrics" | "queue" | "effects">("lyrics");
const speed = ref(1);
const isDragging = ref(false);

/**
 * 波浪进度条的取值范围。
 * `m3e-linear-progress-indicator` 要求 `0 <= value <= max`；未加载歌曲时时长为 0/NaN，
 * 这里给一个安全上限，避免 max<=0 让进度计算退化。
 */
const progressMax = computed(() => (player.duration > 0 ? player.duration : 100));
const progressValue = computed(() =>
  player.duration > 0 ? Math.min(player.currentTime, player.duration) : 0,
);
const commentsOpen = ref(false);
const panelOpen = ref(false);
const panelAnchor = ref<HTMLElement | null>(null);

/**
 * 窄屏（移动端）下封面与歌词互斥显示。
 *
 * 桌面端是左右两栏并排；窄屏堆叠成一列之后，封面、控制、歌词全挤在一屏里，
 * 歌词被压成很窄的一条，也不是移动端音乐 App 的习惯做法。
 * 移动端改成：默认只显示封面与控制，点封面切到歌词，点歌词以外的空白切回封面。
 */
const isNarrow = ref(false);
const mobileLyrics = ref(false);
let narrowMq: MediaQueryList | null = null;
function onNarrowChange(e: MediaQueryListEvent) {
  isNarrow.value = e.matches;
  // 回到宽屏就把互斥状态清掉，免得下次变窄时停在歌词页
  if (!e.matches) mobileLyrics.value = false;
}
if (typeof window !== "undefined" && typeof window.matchMedia === "function") {
  narrowMq = window.matchMedia("(max-width: 720px)");
  isNarrow.value = narrowMq.matches;
  narrowMq.addEventListener("change", onNarrowChange);
}
onBeforeUnmount(() => narrowMq?.removeEventListener("change", onNarrowChange));

/** 点封面：窄屏进歌词，桌面端维持原有「看评论」行为。 */
function onCoverTap() {
  if (isNarrow.value) {
    mobileLyrics.value = true;
    return;
  }
  toggleComments();
}

/** 点空白处切回封面。歌词行、按钮、进度条这些可交互元素不算空白。 */
function onBodyTap(e: MouseEvent) {
  if (!isNarrow.value || !mobileLyrics.value) return;
  const el = e.target as HTMLElement | null;
  if (!el) return;
  const hit = el.closest(
    "button, a, m3e-button, m3e-icon-button, .lyric-item, .progress-track, .tools-panel, input, textarea",
  );
  if (!hit) mobileLyrics.value = false;
}

const { startDrag } = useWindowDrag();

/** 当前在线歌曲的网易云 ID（仅网易云在线歌曲可查评论/红心） */
const neteaseSongId = computed(() => {
  if (!player.song || player.song.kind !== "online") return null;
  const n = Number(player.song.id);
  return Number.isFinite(n) && n > 0 ? n : null;
});
/** 评论按钮：仅登录网易云且当前为在线歌曲时显示 */
const canShowComments = computed(() => netease.loggedIn && neteaseSongId.value != null);

/** 当前歌曲是否有翻译/罗马音副行（无则切换按钮置灰） */
const hasSubLine = computed(() => player.lyrics.some((l) => l.translation || l.romaji));

/** 副行显示模式按钮：翻译 ⇄ 罗马音 */
const subModeLabel = computed(() =>
  settings.lyricSubMode === "translation" ? t("player.translation") : t("player.romaji"),
);
function cycleSubMode() {
  settings.lyricSubMode = settings.lyricSubMode === "translation" ? "romaji" : "translation";
}

function t(key: string) {
  return translate(settings.lang, key);
}

function isWebDavItem(item: unknown): item is { path: string } {
  return typeof item === "object" && item !== null && "isDir" in item;
}

/** 歌词来源徽标：仅「更精确的逐字歌词」开启且当前歌曲完成尝试后显示；点击可切换来源 */
const sourceBadge = computed(() => {
  const switchHint = t("player.lyricSwitchHint");
  if (!settings.preciseLyrics || !player.lyricsSource) return null;
  if (player.lyricsSource === "qq") {
    return {
      text: t("player.lyricSourceQq"),
      hint: `${t("player.lyricSourceQqHint")} · ${switchHint}`,
    };
  }
  if (player.lyricsSource === "kg") {
    return {
      text: t("player.lyricSourceKg"),
      hint: `${t("player.lyricSourceKgHint")} · ${switchHint}`,
    };
  }
  if (player.lyricsSource === "meting") {
    return {
      text: t("player.lyricSourceMeting"),
      hint: `${t("player.lyricSourceMetingHint")} · ${switchHint}`,
    };
  }
  const reason = player.lyricFallbackReason
    ? t(`player.lyricReason_${player.lyricFallbackReason}`)
    : "";
  const detail = player.lyricFallbackDetail ? `：${player.lyricFallbackDetail}` : "";
  return {
    text: t("player.lyricSourceLocal"),
    hint: `${reason ? `${t("player.lyricSourceLocal")}（${reason}${detail}）` : t("player.lyricSourceLocal")} · ${switchHint}`,
  };
});

function formatTime(s: number) {
  if (Number.isNaN(s)) return "0:00";
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec < 10 ? "0" : ""}${sec}`;
}

function onProgressClick(e: MouseEvent) {
  const bar = e.currentTarget as HTMLElement;
  const rect = bar.getBoundingClientRect();
  const pct = (e.clientX - rect.left) / rect.width;
  player.seek(pct * player.duration);
}

function cycleSpeed() {
  const speeds = [1, 1.5, 2, 0.5, 0.75];
  speed.value = speeds[(speeds.indexOf(speed.value) + 1) % speeds.length];
  player.setPlaybackRate(speed.value);
}

/** 点击专辑封面：切换评论面板（仅网易云在线歌曲可用） */
function toggleComments() {
  if (!canShowComments.value) return;
  commentsOpen.value = !commentsOpen.value;
}

/** 功能面板：点击外部或按 Esc 关闭 */
function onDocPointerDown(e: PointerEvent) {
  if (panelOpen.value && panelAnchor.value && !panelAnchor.value.contains(e.target as Node)) {
    panelOpen.value = false;
  }
}
function onDocKeyDown(e: KeyboardEvent) {
  if (e.key === "Escape" && panelOpen.value) panelOpen.value = false;
}

onMounted(() => {
  // audio 元素由 store 全局持有，这里只确保已起播
  player.initAudio();
  player.setPlaybackRate(speed.value);
  document.addEventListener("pointerdown", onDocPointerDown, true);
  document.addEventListener("keydown", onDocKeyDown);
});

onBeforeUnmount(() => {
  // 不中断播放，退出后由 MiniPlayer 接管
  player.detachAudio();
  document.removeEventListener("pointerdown", onDocPointerDown, true);
  document.removeEventListener("keydown", onDocKeyDown);
});
</script>

<template>
  <div class="player-page">
    <FluidBackground />

    <!-- 顶部覆盖层（空白处可拖拽窗口） -->
    <div class="player-topbar" @pointerdown="startDrag">
      <button class="back" @click="router.back()" @pointerdown.stop>
        <span class="material-symbols-outlined">arrow_back</span> {{ t("player.back") }}
      </button>
    </div>

    <div
      class="player-body"
      :class="{ 'mobile-lyrics': mobileLyrics, 'show-panel': rightTab !== 'lyrics' }"
      @click="onBodyTap"
    >
      <!-- 左栏：封面 + 信息 + 进度 + 控制 -->
      <div class="left-col">
        <div class="cover-wrap" :class="{ clickable: canShowComments }" @click="onCoverTap">
          <div v-if="player.song?.cover" class="cover">
            <img :src="player.song.cover" alt="" />
          </div>
          <div v-else class="cover default">
            <span class="material-symbols-outlined">music_note</span>
          </div>
          <div v-if="canShowComments" class="cover-hint">
            <span class="material-symbols-outlined">chat_bubble</span>
            {{ t("netease.comments") }}
          </div>
        </div>

        <div class="song-info">
          <div class="title">{{ player.song?.title || "—" }}</div>
          <div class="artist">
            {{ player.song?.artist || "" }}<span v-if="player.song?.album"> · </span
            >{{ player.song?.album || "" }}
          </div>
        </div>

        <div class="progress-section">
          <div
            class="progress-track"
            :class="{ dragging: isDragging }"
            @mousedown="isDragging = true"
            @mousemove="isDragging && onProgressClick($event)"
            @mouseup="isDragging = false"
            @mouseleave="isDragging = false"
            @click="onProgressClick"
          >
            <!-- 进度条本体交给 @m3e/web：variant="wavy" 即 M3 Expressive 的波浪进度条。
                 点击/拖动跳转挂在外层 .progress-track，视觉一律由组件令牌控制。 -->
            <m3e-linear-progress-indicator
              variant="wavy"
              :max="progressMax"
              :value="progressValue"
            ></m3e-linear-progress-indicator>
          </div>
          <div class="time-row">
            <span>{{ formatTime(player.currentTime) }}</span>
            <span>-{{ formatTime(player.duration - player.currentTime) }}</span>
          </div>
        </div>

        <div class="controls">
          <div class="ctrl-group left">
            <button
              class="side-btn"
              :class="{ active: player.repeatMode !== 'off' }"
              :title="t('player.repeat')"
              @click="player.cycleRepeat()"
            >
              <span
                class="material-symbols-outlined"
                :class="{ filled: player.repeatMode !== 'off' }"
                >{{ player.repeatMode === "one" ? "repeat_one" : "repeat" }}</span
              >
            </button>
            <button
              class="side-btn"
              :class="{ active: player.shuffleMode }"
              :title="t('player.shuffle')"
              @click="player.toggleShuffle()"
            >
              <span class="material-symbols-outlined" :class="{ filled: player.shuffleMode }"
                >shuffle</span
              >
            </button>
          </div>
          <div class="ctrl-group center">
            <button class="side-btn" :title="t('player.prev')" @click="player.previous()">
              <span class="material-symbols-outlined filled">skip_previous</span>
            </button>
            <button
              class="main-btn"
              :title="player.playing ? t('player.pause') : t('player.play')"
              @click="player.togglePlay()"
            >
              <PlayerControlIcon :name="player.playing ? 'pause' : 'play'" />
            </button>
            <button class="side-btn" :title="t('player.next')" @click="player.next()">
              <span class="material-symbols-outlined filled">skip_next</span>
            </button>
          </div>
          <div class="ctrl-group right">
            <!-- 功能面板：向上悬浮展开歌词 / 队列 / 音效 + 逐字方案 + 翻译 -->
            <div ref="panelAnchor" class="panel-anchor" @pointerdown.stop>
              <button
                class="side-btn panel-toggle"
                :class="{ active: panelOpen }"
                :title="t('player.tools')"
                :aria-label="t('player.tools')"
                @click="panelOpen = !panelOpen"
              >
                <span class="material-symbols-outlined">tune</span>
              </button>

              <Transition name="panel-pop">
                <div v-if="panelOpen" class="tools-panel">
                  <div class="segment">
                    <button
                      class="seg-btn"
                      :class="{ active: rightTab === 'lyrics' }"
                      @click="rightTab = 'lyrics'"
                    >
                      {{ t("actions.lyrics") }}
                    </button>
                    <button
                      class="seg-btn"
                      :class="{ active: rightTab === 'queue' }"
                      @click="rightTab = 'queue'"
                    >
                      {{ t("actions.queue") }}
                    </button>
                    <button
                      class="seg-btn"
                      :class="{ active: rightTab === 'effects' }"
                      @click="rightTab = 'effects'"
                    >
                      {{ t("player.effects") }}
                    </button>
                  </div>

                  <div v-if="sourceBadge || hasSubLine" class="tools-extra">
                    <button
                      v-if="sourceBadge"
                      class="source-badge"
                      :class="player.lyricsSource"
                      :title="sourceBadge.hint"
                      @click="player.switchLyricSource()"
                    >
                      <span class="material-symbols-outlined">
                        {{
                          player.lyricsSource === "qq"
                            ? "verified"
                            : player.lyricsSource === "kg"
                              ? "graphic_eq"
                              : player.lyricsSource === "meting"
                                ? "cloud"
                                : "info"
                        }}
                      </span>
                      {{ sourceBadge.text }}
                    </button>
                    <button
                      v-if="hasSubLine"
                      class="source-badge sub"
                      :title="t('player.lyricSubModeSwitch')"
                      @click="cycleSubMode"
                    >
                      <span class="material-symbols-outlined">
                        {{ settings.lyricSubMode === "translation" ? "translate" : "abc" }}
                      </span>
                      {{ subModeLabel }}
                    </button>
                  </div>
                </div>
              </Transition>
            </div>
            <button class="side-btn speed" @click="cycleSpeed">{{ speed }}x</button>
          </div>
        </div>
      </div>

      <!-- 右栏：歌词 / 队列 / 音效内容（切换控件已移入底部控制栏功能面板） -->
      <div class="right-col">
        <div class="right-content">
          <LyricsView v-if="rightTab === 'lyrics'" />
          <AudioEffectsPanel v-else-if="rightTab === 'effects'" />
          <div v-else-if="player.queue.length" class="queue-list">
            <button
              v-for="(item, i) in player.queue"
              :key="player.queueTitle(item) + (isWebDavItem(item) ? item.path : item.id)"
              class="queue-item"
              :class="{ current: i === player.currentIndex }"
              @click="player.playFromQueue(i)"
            >
              <span class="q-index tabular-nums">
                <span v-if="i !== player.currentIndex">{{ i + 1 }}</span>
                <span v-else class="material-symbols-outlined">equalizer</span>
              </span>
              <span class="q-names">
                <span class="q-title">{{ player.queueTitle(item) }}</span>
                <span class="q-artist">{{ player.queueArtist(item) }}</span>
              </span>
              <span class="q-time tabular-nums">
                {{ formatDuration(player.queueDuration(item)) }}
              </span>
            </button>
          </div>
          <div v-else class="queue-empty">{{ t("actions.queue") }}</div>
        </div>
      </div>

      <CommentsPanel
        :open="commentsOpen"
        :song-id="neteaseSongId"
        :title="player.song?.title"
        :artist="player.song?.artist"
        @close="commentsOpen = false"
      />
    </div>
  </div>
</template>

<style scoped>
.player-page {
  position: fixed;
  inset: 0;
  overflow: hidden;
  background: #000;
  color: #fff;
  font-family: var(--lm-player-font);
}
.player-topbar {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  /* .player-page 是 position:fixed; inset:0，绝对定位子元素又是相对它的
     内边距盒定位，所以给父级加 padding 不会把顶栏推下去 —— 安全区必须写在
     顶栏自己身上。移动端的 env() 才有值，桌面端为 0。 */
  padding-top: calc(16px + env(safe-area-inset-top));
  padding-bottom: 16px;
  padding-left: calc(24px + env(safe-area-inset-left));
  padding-right: calc(24px + env(safe-area-inset-right));
  z-index: 10;
  background: linear-gradient(to bottom, rgba(0, 0, 0, 0.5), transparent);
}
.back {
  position: absolute;
  left: 24px;
  top: calc(50% + 6px);
  transform: translateY(-50%);
  border: none;
  background: transparent;
  color: #fff;
  font-size: 15px;
  cursor: pointer;
  opacity: 0.9;
  display: flex;
  align-items: center;
  gap: 4px;
}
.back:hover {
  opacity: 1;
}

/* 底部控制栏功能面板（向上展开） */
.panel-anchor {
  position: relative;
  display: flex;
  align-items: center;
}
.panel-toggle:hover {
  opacity: 1;
}
.panel-toggle.active {
  opacity: 1;
  color: #fff;
}
.panel-toggle .material-symbols-outlined {
  font-size: 21px;
}
.tools-panel {
  position: absolute;
  bottom: calc(100% + 12px);
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  flex-direction: column;
  gap: 12px;
  align-items: center;
  min-width: 240px;
  padding: 14px;
  border-radius: var(--lm-shape-dialog);
  background: rgba(28, 28, 30, 0.82);
  backdrop-filter: blur(20px) saturate(180%);
  -webkit-backdrop-filter: blur(20px) saturate(180%);
  border: 1px solid rgba(255, 255, 255, 0.12);
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.5);
  z-index: 30;
}
.tools-panel .segment {
  align-self: stretch;
  justify-content: center;
  margin: 0;
}
.tools-extra {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 8px;
}
.panel-pop-enter-active,
.panel-pop-leave-active {
  transition:
    opacity 200ms var(--md-sys-motion-spring-spatial),
    transform 200ms var(--md-sys-motion-spring-spatial);
}
.panel-pop-enter-from,
.panel-pop-leave-to {
  opacity: 0;
  transform: translateX(-50%) translateY(10px) scale(0.94);
}
.player-body {
  height: 100%;
  display: flex;
  /* 60px 是给顶部返回按钮让位；移动端还要再让开状态栏/灵动岛。 */
  padding-top: calc(60px + env(safe-area-inset-top));
}
.left-col {
  flex: 5;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 0 20px;
  z-index: 2;
}
.right-col {
  flex: 5.5;
  display: flex;
  flex-direction: column;
  padding: 0 20px;
  z-index: 2;
}

.cover-wrap {
  position: relative;
  width: min(42vw, 52vh);
  aspect-ratio: 1;
  border-radius: calc(min(42vw, 52vh) * 0.14);
  overflow: hidden;
  box-shadow:
    0 8px 32px rgba(0, 0, 0, 0.35),
    0 4px 16px rgba(0, 0, 0, 0.25);
  transition:
    transform 250ms cubic-bezier(0.25, 0.8, 0.25, 1),
    filter 250ms cubic-bezier(0.25, 0.8, 0.25, 1);
}
.cover-wrap:hover {
  transform: scale(1.05);
  filter: brightness(0.85);
}
.cover-wrap.clickable {
  cursor: pointer;
}
.cover-hint {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 16px 12px 14px;
  background: linear-gradient(to top, rgba(0, 0, 0, 0.62), transparent);
  color: #fff;
  font-size: 13px;
  font-weight: 500;
  opacity: 0;
  transition: opacity 220ms var(--md-sys-motion-spring-effects-fast);
  pointer-events: none;
}
.cover-wrap.clickable:hover .cover-hint {
  opacity: 1;
}
.cover-hint .material-symbols-outlined {
  font-size: 18px;
}
.cover {
  width: 100%;
  height: 100%;
}
.cover img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.cover.default {
  display: flex;
  align-items: center;
  justify-content: center;
  background: #222;
}
.cover.default .material-symbols-outlined {
  font-size: 120px;
}
.song-info {
  margin-top: 28px;
  text-align: center;
}
.song-info .title {
  font-size: 24px;
  font-weight: 700;
}
.song-info .artist {
  font-size: 14px;
  opacity: 0.6;
  margin-top: 6px;
}
.progress-section {
  width: 425px;
  margin-top: 24px;
}
/* 进度条视觉全部交给 m3e-linear-progress-indicator（variant="wavy"）。
   这里只提供点击/拖动的命中区域，并把组件令牌换成应用色板；
   波浪的振幅/波长沿用组件默认（3px / 40px），只把厚度对齐原来的 6px。 */
.progress-track {
  width: 425px;
  height: 12px;
  display: flex;
  align-items: center;
  cursor: pointer;
}
.progress-track m3e-linear-progress-indicator {
  width: 100%;
  --m3e-linear-progress-indicator-thickness: 6px;
  --m3e-progress-indicator-track-color: color-mix(
    in srgb,
    var(--md-sys-color-on-surface) 22%,
    transparent
  );
  --m3e-progress-indicator-color: var(--md-sys-color-primary);
}
.time-row {
  display: flex;
  justify-content: space-between;
  margin-top: 6px;
  font-size: 12px;
  opacity: 0.7;
}
.controls {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 425px;
  margin-top: 16px;
}
.ctrl-group {
  display: flex;
  align-items: center;
  gap: 10px;
}
.main-btn {
  width: 64px;
  height: 64px;
  border-radius: 50%;
  border: 1px solid color-mix(in srgb, var(--md-sys-color-primary) 70%, transparent);
  background: var(--md-sys-color-primary);
  color: var(--md-sys-color-on-primary);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: var(--md-elevation-2);
  transition:
    transform 200ms var(--md-sys-motion-spring),
    box-shadow 200ms var(--md-sys-motion-spring-effects-fast);
}
.main-btn .player-control-icon {
  width: 34px;
  height: 30px;
  filter: drop-shadow(0 0 6px rgba(255, 255, 255, 0.2));
}
.main-btn:hover {
  transform: scale(1.04);
  box-shadow: var(--md-elevation-3);
}
.main-btn:active {
  transform: scale(0.8);
}
.side-btn {
  width: 44px;
  height: 44px;
  border: 1px solid color-mix(in srgb, var(--md-sys-color-on-surface) 22%, transparent);
  border-radius: 50%;
  background: color-mix(in srgb, var(--md-sys-color-surface-container-high) 72%, transparent);
  color: var(--md-sys-color-on-surface);
  opacity: 0.9;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  filter: drop-shadow(0 0 8px rgba(0, 0, 0, 0.25));
}
.side-btn .material-symbols-outlined {
  font-size: 21px;
  font-variation-settings:
    "FILL" 1,
    "wght" 500,
    "GRAD" 0,
    "opsz" 24;
}
.side-btn.active {
  opacity: 1;
  color: var(--md-sys-color-primary);
  border-color: var(--md-sys-color-primary);
  background: color-mix(in srgb, var(--md-sys-color-primary-container) 72%, transparent);
}
.side-btn:active {
  transform: scale(0.8);
}
.speed {
  font-size: 13px;
  width: 44px;
}
.segment {
  display: flex;
  gap: 6px;
  padding: 3px;
  background: rgba(255, 255, 255, 0.12);
  border-radius: 12px;
  align-self: flex-start;
}

.source-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 5px 12px;
  border: none;
  border-radius: 999px;
  font-size: 12px;
  white-space: nowrap;
  font-family: inherit;
  cursor: pointer;
  background: rgba(255, 255, 255, 0.1);
  color: rgba(255, 255, 255, 0.65);
  transition: background 180ms var(--md-sys-motion-spring-effects-fast);
}
.source-badge:hover {
  background: rgba(255, 255, 255, 0.18);
}
.source-badge .material-symbols-outlined {
  font-size: 14px;
}
.source-badge.qq {
  background: rgba(76, 217, 100, 0.16);
  color: #7cfc9b;
}
.source-badge.kg {
  background: rgba(56, 160, 255, 0.18);
  color: #7cc4ff;
}
.source-badge.meting {
  background: rgba(236, 72, 91, 0.18);
  color: #ff94a3;
}
.source-badge.local {
  background: rgba(255, 255, 255, 0.1);
  color: rgba(255, 255, 255, 0.65);
}
.source-badge.sub {
  background: rgba(255, 255, 255, 0.1);
  color: rgba(255, 255, 255, 0.75);
}
.source-badge.sub.disabled {
  opacity: 0.4;
  cursor: default;
}
.seg-btn {
  border: none;
  background: transparent;
  color: #fff;
  opacity: 0.6;
  padding: 6px 18px;
  border-radius: 10px;
  cursor: pointer;
  font-size: 13px;
  transition: all 200ms var(--md-sys-motion-spring-effects-fast);
}
.seg-btn.active {
  background: #fff;
  color: #000;
  opacity: 1;
}
.right-content {
  flex: 1;
  overflow: hidden;
}
.queue-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  overflow-y: auto;
  height: 100%;
}
.queue-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 9px 12px;
  border: none;
  border-radius: 10px;
  background: transparent;
  color: rgba(255, 255, 255, 0.75);
  font-family: inherit;
  text-align: left;
  cursor: pointer;
  transition: background 180ms var(--md-sys-motion-spring-effects-fast);
}
.queue-item:hover {
  background: rgba(255, 255, 255, 0.08);
}
.queue-item.current {
  background: rgba(255, 255, 255, 0.14);
  color: #fff;
}
.q-index {
  width: 22px;
  text-align: center;
  font-size: 12px;
  opacity: 0.6;
}
.q-index .material-symbols-outlined {
  font-size: 16px;
  opacity: 1;
}
.q-names {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
}
.q-title {
  font-size: 14px;
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.q-artist {
  font-size: 12px;
  opacity: 0.6;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.q-time {
  font-size: 12px;
  opacity: 0.55;
}
.queue-empty {
  color: rgba(255, 255, 255, 0.5);
  text-align: center;
  margin-top: 40%;
}
/* ── 窄屏（手机竖屏 / 分屏）─────────────────────────────────────────
   桌面版是左右双栏 + 固定 425px 的控制区，手机上放不下：
   两栏各剩不到 200px，进度条直接溢出。这里改成上下堆叠，
   并把固定宽度交还给容器。 */
@media (max-width: 720px) {
  .player-body {
    flex-direction: column;
    /* 原先只有 8px，连顶栏都让不开，封面直接顶到返回按钮那一行。
       顶栏高度 = 24px 图标 + 上下 16px 内边距。 */
    padding-top: calc(56px + env(safe-area-inset-top));
    overflow-y: auto;
    overscroll-behavior: contain;
  }

  /* 窄屏下封面与歌词互斥，详见 <script> 里 mobileLyrics 的说明。
     切成队列/音效面板时照常显示右栏，否则那两个功能在移动端就没入口了。 */
  .player-body:not(.mobile-lyrics):not(.show-panel) .right-col {
    display: none;
  }
  .player-body.mobile-lyrics .left-col {
    display: none;
  }
  .player-body.mobile-lyrics .right-col {
    flex: 1 1 auto;
    min-height: 0;
  }
  .left-col {
    flex: 0 0 auto;
    justify-content: flex-start;
    padding: 0 20px;
  }
  .right-col {
    flex: 1 1 auto;
    min-height: 0;
    padding: 0 16px 12px;
  }
  .cover-wrap {
    width: min(62vw, 32vh);
    border-radius: calc(min(62vw, 32vh) * 0.14);
  }
  .song-info {
    margin-top: 16px;
  }
  .song-info .title {
    font-size: 19px;
  }
  .progress-section,
  .progress-track,
  .controls {
    width: 100%;
  }
  .progress-section {
    margin-top: 16px;
  }
  /* 6px 的进度条手指点不准，窄屏给足命中高度并加粗波浪 */
  .progress-track {
    height: 20px;
  }
  .progress-track m3e-linear-progress-indicator {
    --m3e-linear-progress-indicator-thickness: 8px;
  }
  .tools-panel {
    min-width: 0;
    width: min(88vw, 340px);
  }
}

/* 触摸设备没有 hover，靠 hover 才出现的反馈会"粘"住或者永远不出现 */
@media (hover: none) {
  .cover-wrap:hover {
    transform: none;
    filter: none;
  }
}
</style>
