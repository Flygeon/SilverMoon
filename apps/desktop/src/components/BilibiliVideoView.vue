<script setup lang="ts">
/**
 * B 站视频详情与播放（全屏浮层）。
 *
 * 播放器复用既有 ArtPlayer + artplayer-plugin-danmuku（与番剧同一套）：
 * - B 站 playurl 走 `fnval=1` 拿到的整段 MP4（durl），ArtPlayer 原生即可播，
 *   无需 DASH 合流；CDN 的防盗链 Referer 由主进程 webRequest 统一补。
 * - 弹幕走 B 站 `list.so`（XML），映射成 ArtPlayer 弹幕格式（utils/bilibili.ts）。
 * - 清晰度 / 分 P 切换在下方信息区，切换后 store 重取 playurl，这里 switchUrl。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import type Artplayer from "artplayer";
import type { Option as DanmukuOption } from "artplayer-plugin-danmuku";
import { useBiliStore } from "@/stores/bilibili";
import { useSettingsStore } from "@/stores/settings";
import { capabilities } from "@/capabilities";
import { biliCount, biliDuration, biliFormatLabel, biliPubdate } from "@/utils/bilibili";
import type { ArtDanmu } from "@/utils/danmaku";
import { translate } from "@shared/i18n";

const emit = defineEmits<{ (e: "close"): void }>();

const bili = useBiliStore();
const settings = useSettingsStore();
const t = (key: string) => translate(settings.lang, key);

const container = ref<HTMLDivElement | null>(null);
const descExpanded = ref(false);
const danmakuOn = ref(settings.danmakuEnabled);

let art: Artplayer | null = null;
let danmakuGen = 0;

const detail = computed(() => bili.detail);
const play = computed(() => bili.play);
const videoUrl = computed(() => play.value?.durl[0] ?? "");
const qualities = computed(() => play.value?.qualities ?? []);
const parts = computed(() => detail.value?.parts ?? []);
const showParts = computed(() => parts.value.length > 1);
const title = computed(() => detail.value?.title || bili.current?.title || t("bili.title"));

function readThemeColor(): string {
  const v = getComputedStyle(document.documentElement)
    .getPropertyValue("--md-sys-color-primary")
    .trim();
  if (v.startsWith("#")) return v;
  const m = v.match(/rgb[a]?\(([^)]+)\)/);
  if (!m) return "#1A5C9E";
  const partsRgb = m[1].split(",").map((x) => Number(x.trim()));
  if (partsRgb.length < 3) return "#1A5C9E";
  return `#${partsRgb
    .slice(0, 3)
    .map((n) => Math.round(n).toString(16).padStart(2, "0"))
    .join("")}`;
}

/** 弹幕加载：按当前 cid 拉取 + 应用时间轴偏移。切 P 时通过 danmakuGen 作废旧请求。 */
async function loadDanmaku(): Promise<ArtDanmu[]> {
  const gen = ++danmakuGen;
  if (!settings.danmakuEnabled) return [];
  const cid = bili.activeCid;
  if (!cid) return [];
  const items = await bili.loadDanmaku(cid);
  if (gen !== danmakuGen) return [];
  const offset = settings.danmakuTimeOffsetMs / 1000;
  return offset ? items.map((d) => ({ ...d, time: Math.max(0, d.time + offset) })) : items;
}

type DanmakuPlugin = {
  load: (d: ArtDanmu[]) => Promise<unknown>;
  show?: () => void;
  hide?: () => void;
  isHide?: boolean;
};

function danmakuPlugin(): DanmakuPlugin | undefined {
  return art?.plugins?.artplayerPluginDanmuku as DanmakuPlugin | undefined;
}

async function reloadDanmaku(): Promise<void> {
  const plugin = danmakuPlugin();
  if (!plugin || !settings.danmakuEnabled) return;
  const items = await loadDanmaku();
  if (art && danmakuPlugin() === plugin) void plugin.load(items);
}

async function createPlayer(url: string): Promise<void> {
  const root = container.value;
  if (!root) return;
  const [{ default: Artplayer }, { default: artplayerPluginDanmuku }] = await Promise.all([
    import("artplayer"),
    import("artplayer-plugin-danmuku"),
  ]);

  const area = Math.max(0, 100 - settings.danmakuArea) / 2;
  const danmukuOpts: DanmukuOption = {
    danmuku: () => loadDanmaku(),
    speed: settings.danmakuSpeed,
    opacity: settings.danmakuOpacity / 100,
    fontSize: settings.danmakuFontSize,
    margin: [`${area}%`, `${area}%`] as [`${number}%`, `${number}%`],
    mode: 0 as const,
    modes: [0, 1, 2] as const,
    antiOverlap: settings.danmakuAntiOverlap,
    visible: settings.danmakuEnabled,
    emitter: false,
  };

  art = new Artplayer({
    container: root,
    url,
    poster: detail.value?.cover || undefined,
    autoplay: true,
    autoMini: false,
    fullscreen: true,
    fullscreenWeb: false,
    playbackRate: true,
    aspectRatio: false,
    screenshot: false,
    setting: false,
    pip: true,
    flip: false,
    miniProgressBar: false,
    volume: 0.8,
    theme: readThemeColor(),
    type: "auto",
    plugins: [artplayerPluginDanmuku(danmukuOpts)],
  });
}

async function mountPlayer(url: string): Promise<void> {
  if (!url) return;
  if (!art) {
    await createPlayer(url);
  } else {
    try {
      await art.switchUrl(url);
    } catch (e) {
      console.warn("[bilibili] switchUrl 失败：", e);
    }
  }
  await reloadDanmaku();
}

let unwatchUrl: (() => void) | null = null;

onMounted(() => {
  if (videoUrl.value) void mountPlayer(videoUrl.value);
  unwatchUrl = watch(videoUrl, (url) => {
    if (url) void mountPlayer(url);
  });
});

onBeforeUnmount(() => {
  unwatchUrl?.();
  unwatchUrl = null;
  danmakuGen += 1;
  art?.destroy(false);
  art = null;
});

async function toggleDanmaku(): Promise<void> {
  const plugin = danmakuPlugin();
  if (!plugin?.show || !plugin?.hide) return;
  if (plugin.isHide) {
    plugin.show();
    danmakuOn.value = true;
  } else {
    plugin.hide();
    danmakuOn.value = false;
  }
}

function openInBrowser(): void {
  const bvid = detail.value?.bvid || bili.current?.bvid;
  if (bvid) void capabilities.openUrl(`https://www.bilibili.com/video/${bvid}`);
}

function partLabel(index: number, fallback: string): string {
  return fallback || `P${index + 1}`;
}

const statItems = computed(() => {
  const s = detail.value?.stat;
  if (!s) return [] as { icon: string; value: number }[];
  return [
    { icon: "play_arrow", value: s.view },
    { icon: "subtitles", value: s.danmaku },
    { icon: "thumb_up", value: s.like },
    { icon: "monetization_on", value: s.coin },
    { icon: "star", value: s.favorite },
    { icon: "share", value: s.share },
  ];
});

const metaItems = computed(() => {
  const d = detail.value;
  if (!d) return [] as string[];
  return [
    d.pubdate ? biliPubdate(d.pubdate) : "",
    d.stat.view ? `${biliCount(d.stat.view)}${t("bili.plays")}` : "",
    d.stat.danmaku ? `${biliCount(d.stat.danmaku)}${t("bili.danmakus")}` : "",
  ].filter(Boolean);
});
</script>

<template>
  <div class="bili-view">
    <!-- 顶栏 -->
    <header class="head lm-glass">
      <m3e-icon-button size="small" :title="t('bili.close')" @click="emit('close')">
        <span class="material-symbols-outlined">arrow_back</span>
      </m3e-icon-button>
      <span class="head-title" :title="title">{{ title }}</span>
      <span class="spacer" />
      <m3e-icon-button
        size="small"
        :title="danmakuOn ? t('bili.danmakuOff') : t('bili.danmakuOn')"
        :class="{ 'is-off': !danmakuOn }"
        @click="toggleDanmaku"
      >
        <span class="material-symbols-outlined">subtitles</span>
      </m3e-icon-button>
      <m3e-icon-button size="small" :title="t('bili.openBrowser')" @click="openInBrowser">
        <span class="material-symbols-outlined">open_in_new</span>
      </m3e-icon-button>
    </header>

    <!-- 播放器 -->
    <div class="player-area">
      <div ref="container" class="art-container" />
      <div v-if="bili.playStatus === 'loading'" class="player-overlay">
        <m3e-loading-indicator class="lm-loading" />
        <span>{{ t("bili.resolving") }}</span>
      </div>
      <div v-else-if="bili.playStatus === 'error' && !videoUrl" class="player-overlay error">
        <span class="material-symbols-outlined">error</span>
        <span class="err-text">{{ bili.playError || t("bili.resolveFailed") }}</span>
        <m3e-button variant="filled" size="small" @click="bili.selectQuality(bili.activeQn)">
          <span slot="icon" class="material-symbols-outlined">refresh</span>
          {{ t("bili.retry") }}
        </m3e-button>
      </div>
    </div>

    <!-- 信息区 -->
    <div class="detail-body">
      <div v-if="bili.detailStatus === 'loading' && !detail" class="detail-loading">
        <m3e-loading-indicator class="lm-loading" />
        {{ t("bili.loadingDetail") }}
      </div>

      <template v-else-if="detail">
        <h2 class="title">{{ detail.title }}</h2>
        <div class="submeta">
          <span v-for="(m, i) in metaItems" :key="i">{{ i > 0 ? "· " : "" }}{{ m }}</span>
        </div>

        <div class="owner-row">
          <span class="avatar">
            <img
              v-if="detail.owner.face"
              :src="detail.owner.face"
              alt=""
              referrerpolicy="no-referrer"
            />
            <span v-else class="material-symbols-outlined">person</span>
          </span>
          <span class="owner-name" :title="detail.owner.name">{{
            detail.owner.name || t("bili.unknownUp")
          }}</span>
        </div>

        <div v-if="qualities.length" class="block">
          <div class="block-label">{{ t("bili.quality") }}</div>
          <div class="chips">
            <m3e-filter-chip
              v-for="q in qualities"
              :key="q"
              class="chip"
              :selected="q === bili.activeQn"
              @click="bili.selectQuality(q)"
            >
              {{ biliFormatLabel(play!, q) }}
            </m3e-filter-chip>
          </div>
        </div>

        <div v-if="showParts" class="block">
          <div class="block-label">{{ t("bili.parts") }}（{{ parts.length }}）</div>
          <div class="parts-grid">
            <button
              v-for="(p, i) in parts"
              :key="p.cid"
              class="part"
              :class="{ active: p.cid === bili.activeCid }"
              :title="partLabel(i, p.part)"
              @click="bili.selectPart(p.cid)"
            >
              <span class="part-name">{{ partLabel(i, p.part) }}</span>
              <span class="part-time tabular-nums">{{ biliDuration(p.duration) }}</span>
            </button>
          </div>
        </div>

        <div class="block">
          <div class="block-label">{{ t("bili.desc") }}</div>
          <p class="desc" :class="{ expanded: descExpanded }">
            {{ detail.desc || t("bili.noDesc") }}
          </p>
          <m3e-button
            v-if="(detail.desc || '').length > 120"
            variant="text"
            size="small"
            @click="descExpanded = !descExpanded"
          >
            {{ descExpanded ? t("bili.collapse") : t("bili.expand") }}
          </m3e-button>
        </div>

        <div class="stat-row tabular-nums">
          <span v-for="s in statItems" :key="s.icon" class="stat">
            <span class="material-symbols-outlined">{{ s.icon }}</span
            >{{ biliCount(s.value) }}
          </span>
        </div>
      </template>

      <div v-else-if="bili.playError" class="detail-error">
        <span class="material-symbols-outlined">error</span>
        <span>{{ bili.playError }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.bili-view {
  position: fixed;
  inset: 0;
  z-index: 200;
  display: flex;
  flex-direction: column;
  background: var(--md-sys-color-surface);
  animation: bili-fade-in 200ms var(--md-sys-motion-spring-effects-fast);
}
@keyframes bili-fade-in {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}

.head {
  flex: none;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 14px;
  border-bottom: 1px solid var(--lm-hairline);
}
.head-title {
  min-width: 0;
  font-size: var(--md-sys-typescale-title-small-size);
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.head .spacer {
  flex: 1;
}
.head .is-off {
  opacity: 0.45;
}

.player-area {
  position: relative;
  flex: none;
  width: 100%;
  /* 保持 16:9 的同时不挤掉信息区 */
  height: min(58vh, 56.25vw);
  background: #000;
}
.art-container {
  position: absolute;
  inset: 0;
}
.player-overlay {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  background: rgba(0, 0, 0, 0.5);
  color: #fff;
  font-size: var(--md-sys-typescale-body-medium-size);
}
.player-overlay .material-symbols-outlined {
  font-size: 34px;
}
.player-overlay.error {
  color: #ffb4ab;
}
.player-overlay .err-text {
  max-width: min(560px, 80%);
  text-align: center;
  color: #fff;
}

.detail-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 18px 22px 40px;
  scrollbar-gutter: stable;
}
.detail-loading {
  display: flex;
  align-items: center;
  gap: 10px;
  color: var(--md-sys-color-on-surface-variant);
}

.title {
  margin: 0;
  font-size: var(--md-sys-typescale-title-medium-size);
  font-weight: 600;
  line-height: 1.35;
}
.submeta {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 6px;
  font-size: var(--md-sys-typescale-body-small-size);
  color: var(--md-sys-color-on-surface-variant);
}

.owner-row {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 14px;
}
.avatar {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 38px;
  height: 38px;
  border-radius: 50%;
  overflow: hidden;
  background: var(--md-sys-color-surface-container-highest);
  color: var(--md-sys-color-on-surface-variant);
}
.avatar img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.owner-name {
  font-size: var(--md-sys-typescale-body-medium-size);
  font-weight: 500;
}

.block {
  margin-top: 20px;
}
.block-label {
  margin-bottom: 8px;
  font-size: var(--md-sys-typescale-label-large-size);
  font-weight: 500;
  color: var(--md-sys-color-on-surface-variant);
}
.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.chips m3e-filter-chip {
  --m3e-chip-container-height: 32px;
}

.parts-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(170px, 1fr));
  gap: 8px;
}
.part {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 12px;
  border: none;
  border-radius: var(--lm-shape-card-inner);
  background: var(--md-sys-color-surface-container);
  color: var(--md-sys-color-on-surface-variant);
  font-family: inherit;
  font-size: var(--md-sys-typescale-body-small-size);
  cursor: pointer;
  transition: background 160ms var(--md-sys-motion-spring-effects-fast);
}
.part:hover {
  background: var(--md-sys-color-surface-container-high);
}
.part.active {
  background: var(--md-sys-color-primary);
  color: var(--md-sys-color-on-primary);
  font-weight: 500;
}
.part-name {
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.part-time {
  flex: none;
  opacity: 0.8;
}

.desc {
  margin: 0 0 4px;
  white-space: pre-wrap;
  word-break: break-word;
  font-size: var(--md-sys-typescale-body-medium-size);
  line-height: 1.7;
  color: var(--md-sys-color-on-surface-variant);
  display: -webkit-box;
  -webkit-line-clamp: 4;
  line-clamp: 4;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.desc.expanded {
  display: block;
  overflow: visible;
}

.stat-row {
  display: flex;
  flex-wrap: wrap;
  gap: 18px;
  margin-top: 22px;
  padding-top: 16px;
  border-top: 1px solid var(--lm-hairline);
  color: var(--md-sys-color-on-surface-variant);
  font-size: var(--md-sys-typescale-body-small-size);
}
.stat {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.stat .material-symbols-outlined {
  font-size: 18px;
}

.detail-error {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 18px;
  color: var(--md-sys-color-error);
}
</style>
