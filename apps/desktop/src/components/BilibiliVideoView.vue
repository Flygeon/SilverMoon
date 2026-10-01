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
import BilibiliComments from "@/components/BilibiliComments.vue";
import BilibiliRelatedList from "@/components/BilibiliRelatedList.vue";
import { useBiliStore } from "@/stores/bilibili";
import { useSettingsStore } from "@/stores/settings";
import { capabilities } from "@/capabilities";
import {
  biliCount,
  biliDuration,
  biliFormatLabel,
  biliPubdate,
  type BiliStream,
} from "@/utils/bilibili";
import { BiliDashSession } from "@/utils/biliDash";
import type { ArtDanmu } from "@/utils/danmaku";
import { translate } from "@shared/i18n";

const emit = defineEmits<{ (e: "login"): void }>();

const bili = useBiliStore();
const settings = useSettingsStore();
const t = (key: string) => translate(settings.lang, key);

const container = ref<HTMLDivElement | null>(null);
const descExpanded = ref(false);
const danmakuOn = ref(settings.danmakuEnabled);
/** 媒体加载失败提示（ArtPlayer 会自动重连，这里负责把原因讲清楚并给条退路） */
const playerError = ref("");

let art: Artplayer | null = null;
let danmakuGen = 0;
/** 当前 DASH（MSE）会话；走 MP4 兜底时为 null */
let dash: BiliDashSession | null = null;

const detail = computed(() => bili.detail);
const play = computed(() => bili.play);
const videoUrl = computed(() => play.value?.durl[0] ?? "");
/** 是否有可播源（DASH 或渐进式 MP4 任一即可） */
const hasSource = computed(() => !!videoUrl.value || (play.value?.dashVideo.length ?? 0) > 0);
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

async function createPlayer(url: string | null): Promise<void> {
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
    url: url ?? "",
    poster: detail.value?.cover || undefined,
    // DASH 走 MSE：这里只创建空 <video>，真正的数据由 BiliDashSession 推进
    type: "auto",
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
    plugins: [artplayerPluginDanmuku(danmukuOpts)],
  });

  // 媒体错误（多为 CDN 防盗链 403/503）——ArtPlayer 会自己重连几轮，
  // 但界面上一片「重新连接」看不出原因，这里显式提示并提供重试。
  art.on("error", () => {
    playerError.value = t("bili.playbackFailed");
  });
  art.on("video:playing", () => {
    playerError.value = "";
  });
}

function retryPlayback(): void {
  playerError.value = "";
  void mountSource();
}

/**
 * 选中的 DASH 视频轨。
 *
 * 两个约束一起满足：
 * - **优先 avc1**：Chromium 对 hev1/av01 的硬解支持因机器而异，avc1 最稳。若某一档
 *   只有 av01（4K/8K 常见），宁可退到低一档的 avc1，也不要直接播不了；
 * - **不高于 `currentQn`**：用户手动选了 480P 就不该偷偷给 1080P。
 *
 * `dashVideo` 在 utils 里已按清晰度 / 码率降序排好，故池子里第一项即最高档。
 */
function pickVideoTrack(currentQn: number): BiliStream | null {
  const list = play.value?.dashVideo ?? [];
  if (!list.length) return null;
  const avc = list.filter((s) => s.codecs.startsWith("avc1"));
  const pool = avc.length ? avc : list;
  return pool.find((s) => s.id <= currentQn) ?? pool[0];
}

/**
 * 挂载播放源。
 *
 * 优先 DASH（MSE 合流）：只有它拿得到 1080P 及以上。若当前环境 / 编码不支持
 * MSE（例如 av01 且系统解码器缺失），退回渐进式 MP4 的 durl —— 那是 720P，
 * 但至少能播，且失败原因会明确写在界面上。
 */
async function mountSource(): Promise<void> {
  playerError.value = "";
  const p = play.value;
  if (!p) return;

  const videoTrack = pickVideoTrack(p.quality || bili.activeQn);
  const audioTrack = p.dashAudio[0] ?? null;

  // 清掉上一轮 DASH 会话（切清晰度 / 切分 P 时 MediaSource 不能复用）
  dash?.destroy();
  dash = null;

  if (videoTrack && BiliDashSession.canPlay(videoTrack, audioTrack)) {
    await mountDash(videoTrack, audioTrack);
    return;
  }

  // 兜底：渐进式 MP4（最高 720P）
  if (p.durl[0]) {
    await mountPlayer(p.durl[0], "auto");
    return;
  }
  if (videoTrack) {
    playerError.value = t("bili.dashUnsupported");
  }
}

/** 用 MSE 会话喂 ArtPlayer（ArtPlayer 只负责 UI 与控件，数据由我们推进）。 */
async function mountDash(videoTrack: BiliStream, audioTrack: BiliStream | null): Promise<void> {
  if (!art) {
    await createPlayer(null);
  }
  const el = art?.video;
  if (!el || !art) return;

  const session = new BiliDashSession();
  dash = session;
  const startTime = el.currentTime > 0 && Number.isFinite(el.currentTime) ? el.currentTime : 0;

  try {
    await session.load(el, {
      video: videoTrack,
      audio: audioTrack,
      startTime,
      onError: (e) => {
        playerError.value = e instanceof Error ? e.message : String(e);
      },
      onReady: () => {
        playerError.value = "";
        void el.play().catch(() => undefined);
      },
    });
  } catch (e) {
    if (dash === session) {
      dash = null;
      playerError.value = e instanceof Error ? e.message : String(e);
    }
    session.destroy();
  }
  await reloadDanmaku();
}

async function mountPlayer(url: string, type: "auto" | "m3u8" = "auto"): Promise<void> {
  if (!url) return;
  playerError.value = "";
  if (!art) {
    await createPlayer(url);
  } else {
    try {
      art.type = type;
      await art.switchUrl(url);
    } catch (e) {
      console.warn("[bilibili] switchUrl 失败：", e);
    }
  }
  await reloadDanmaku();
}

let unwatchUrl: (() => void) | null = null;

/** 关闭浮层：直接改 store 状态（不经过 emit 中转，避免多一层出错点） */
function close(): void {
  bili.closeVideo();
}

/** Esc 关闭浮层（全屏时交给 ArtPlayer 自己处理 Esc 退全屏） */
function onKeydown(e: KeyboardEvent): void {
  if (e.key === "Escape" && !document.fullscreenElement) close();
}

onMounted(() => {
  window.addEventListener("keydown", onKeydown);
  document.addEventListener("pointerdown", onDocPointerDown, true);
  if (hasSource.value) void mountSource();
  // 播放地址变化（首帧到达 / 切清晰度 / 切分 P）时重挂
  unwatchUrl = watch(
    () => [play.value?.quality, play.value?.durl[0], bili.activeCid].join("|"),
    () => {
      if (hasSource.value) void mountSource();
    },
  );
});

onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKeydown);
  document.removeEventListener("pointerdown", onDocPointerDown, true);
  unwatchUrl?.();
  unwatchUrl = null;
  danmakuGen += 1;
  dash?.destroy();
  dash = null;
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

/** 点 UP 主头像 / 昵称进主页。 */
function openUp(): void {
  bili.openCurrentUp();
}

function partLabel(index: number, fallback: string): string {
  return fallback || `P${index + 1}`;
}

// ---- 互动（点赞 / 投币 / 收藏 / 分享）----
const coinOpen = ref(false);

function sendCoin(n: number): void {
  coinOpen.value = false;
  void bili.addCoin(n);
}

/** 点气泡外面就关掉（与 WindowTitleBar 的外观菜单同一套做法） */
function onDocPointerDown(e: PointerEvent): void {
  if (!coinOpen.value) return;
  if ((e.target as HTMLElement | null)?.closest(".act-wrap")) return;
  coinOpen.value = false;
}

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
    <!-- 顶栏（用原生 button：浮层里的操作必须 100% 可点，不依赖自定义元素的事件转发） -->
    <header class="head lm-glass">
      <button class="head-btn" type="button" :title="t('bili.close')" @click="close">
        <span class="material-symbols-outlined">arrow_back</span>
      </button>
      <span class="head-title" :title="title">{{ title }}</span>
      <span class="spacer" />
      <button
        class="head-btn"
        type="button"
        :class="{ off: !danmakuOn }"
        :title="danmakuOn ? t('bili.danmakuOff') : t('bili.danmakuOn')"
        @click="toggleDanmaku"
      >
        <span class="material-symbols-outlined">subtitles</span>
      </button>
      <button class="head-btn" type="button" :title="t('bili.openBrowser')" @click="openInBrowser">
        <span class="material-symbols-outlined">open_in_new</span>
      </button>
    </header>

    <!-- 左栏（播放器 / 信息 / 评论） + 右栏（相关推荐）；窗口放不下时自动折成一栏 -->
    <div class="content">
      <div class="main">
        <!-- 播放器 -->
        <div class="player-area">
          <div ref="container" class="art-container" />
          <div v-if="bili.playStatus === 'loading'" class="player-overlay">
            <m3e-loading-indicator class="lm-loading" />
            <span>{{ t("bili.resolving") }}</span>
          </div>
          <div v-else-if="bili.playStatus === 'error' && !hasSource" class="player-overlay error">
            <span class="material-symbols-outlined">error</span>
            <span class="err-text">{{ bili.playError || t("bili.resolveFailed") }}</span>
            <m3e-button variant="filled" size="small" @click="bili.selectQuality(bili.activeQn)">
              <span slot="icon" class="material-symbols-outlined">refresh</span>
              {{ t("bili.retry") }}
            </m3e-button>
          </div>
          <div v-else-if="playerError" class="player-overlay error">
            <span class="material-symbols-outlined">error</span>
            <span class="err-text">{{ playerError }}</span>
            <span class="err-hint">{{ t("bili.playbackHint") }}</span>
            <m3e-button variant="filled" size="small" @click="retryPlayback">
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
              <!-- 头像 + 昵称整块可点：进 UP 主主页 -->
              <button
                class="owner-link"
                type="button"
                :title="t('bili.userHome')"
                :disabled="!detail.owner.mid"
                @click="openUp"
              >
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
                <span class="material-symbols-outlined go">chevron_right</span>
              </button>
              <span class="grow" />
              <m3e-button
                v-if="detail.owner.mid"
                :variant="bili.relation?.followed ? 'tonal' : 'filled'"
                size="small"
                :disabled="bili.acting.follow"
                @click="bili.toggleFollow()"
              >
                <span slot="icon" class="material-symbols-outlined">{{
                  bili.relation?.followed ? "check" : "add"
                }}</span>
                {{ bili.relation?.followed ? t("bili.followed") : t("bili.follow") }}
              </m3e-button>
            </div>

            <!-- 互动：点赞 / 投币 / 收藏 / 分享（对应参考布局里那排胶囊按钮） -->
            <div class="actions">
              <button
                class="act"
                :class="{ on: bili.relation?.liked }"
                type="button"
                :title="t('bili.likeAction')"
                :disabled="bili.acting.like"
                @click="bili.toggleLike()"
              >
                <span class="material-symbols-outlined">thumb_up</span>
                <span class="tabular-nums">{{ biliCount(detail.stat.like) }}</span>
              </button>

              <div class="act-wrap">
                <button
                  class="act"
                  :class="{ on: (bili.relation?.coin ?? 0) > 0 }"
                  type="button"
                  :title="t('bili.coinAction')"
                  @click="coinOpen = !coinOpen"
                >
                  <span class="material-symbols-outlined">monetization_on</span>
                  <span class="tabular-nums">{{ biliCount(detail.stat.coin) }}</span>
                </button>
                <Transition name="coin-pop">
                  <div v-if="coinOpen" class="coin-pop lm-glass">
                    <button class="coin-opt" type="button" @click="sendCoin(1)">
                      <span class="material-symbols-outlined">monetization_on</span>
                      {{ t("bili.coinOne") }}
                    </button>
                    <button class="coin-opt" type="button" @click="sendCoin(2)">
                      <span class="material-symbols-outlined">monetization_on</span>
                      {{ t("bili.coinTwo") }}
                    </button>
                  </div>
                </Transition>
              </div>

              <button
                class="act"
                :class="{ on: bili.relation?.favored }"
                type="button"
                :title="t('bili.favAction')"
                :disabled="bili.acting.fav"
                @click="bili.toggleFavorite()"
              >
                <span class="material-symbols-outlined">{{
                  bili.relation?.favored ? "star" : "star_border"
                }}</span>
                <span class="tabular-nums">{{ biliCount(detail.stat.favorite) }}</span>
              </button>

              <button class="act" type="button" @click="bili.shareVideo()">
                <span class="material-symbols-outlined">share</span>
                {{ t("bili.share") }}
              </button>
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
          </template>

          <div v-else-if="bili.playError" class="detail-error">
            <span class="material-symbols-outlined">error</span>
            <span>{{ bili.playError }}</span>
          </div>
        </div>
        <BilibiliComments @login="emit('login')" />
      </div>

      <!-- 右栏：相关推荐（sticky，长评论区滚动时始终可见） -->
      <aside class="side">
        <BilibiliRelatedList
          :videos="bili.related"
          :status="bili.relatedStatus"
          @open="bili.openVideo"
        />
      </aside>
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
  /* 与 WindowTitleBar 同一套做法：留白处即窗口拖拽区（浮层盖在标题栏上，
     顶层那条 drag 区域仍在生效），可点元素必须显式 no-drag —— 见下 */
  -webkit-app-region: drag;
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
.head-btn {
  flex: none;
  display: grid;
  place-items: center;
  width: 36px;
  height: 36px;
  padding: 0;
  border: none;
  border-radius: var(--md-sys-shape-corner-full);
  background: transparent;
  color: var(--md-sys-color-on-surface-variant);
  cursor: pointer;
  /* 关键：不排除拖拽的话，按钮落在标题栏那条 drag 区域里，点击会被当成拖窗口
     （表现就是「点了没反应」）。WindowTitleBar 的 .tb-actions 同理。 */
  -webkit-app-region: no-drag;
  transition: background 160ms var(--md-sys-motion-spring-effects-fast);
}
.head-btn:hover {
  background: var(--md-sys-color-surface-container-high);
}
.head-btn:focus-visible {
  outline: 2px solid var(--md-sys-color-primary);
  outline-offset: -2px;
}
.head-btn .material-symbols-outlined {
  font-size: 20px;
}
.head-btn.off {
  opacity: 0.45;
}

/* 左栏（播放器 / 信息 / 评论） + 右栏（相关推荐）：一栏放不下就折成上下 */
.content {
  flex: 1;
  min-height: 0;
  display: flex;
  align-items: flex-start;
  flex-wrap: wrap;
  gap: 22px;
  padding: 18px 22px 40px;
  overflow-y: auto;
  scrollbar-gutter: stable;
}
.main {
  flex: 1 1 560px;
  min-width: 0;
  display: flex;
  flex-direction: column;
}
.side {
  flex: 0 1 336px;
  min-width: 264px;
  /* 评论区很长，右栏跟着滚就没法边看边选了 */
  position: sticky;
  top: 0;
  padding: 10px;
  border-radius: var(--lm-shape-card);
  background: var(--md-sys-color-surface-container-low);
  box-shadow: inset 0 0 0 1px var(--lm-hairline);
}

.player-area {
  position: relative;
  width: 100%;
  /* 宽度由左栏决定，高度按 16:9 跟随；窗口很矮时限制一下不撑破视口 */
  aspect-ratio: 16 / 9;
  max-height: 62vh;
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
.player-overlay .err-hint {
  max-width: min(560px, 80%);
  text-align: center;
  font-size: var(--md-sys-typescale-body-small-size);
  line-height: 1.6;
  color: rgba(255, 255, 255, 0.75);
}

/* 滚动交给 .content（整页一起滚），这里只负责信息区的排版 */
.detail-body {
  padding: 16px 0 0;
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
.grow {
  flex: 1;
}

/* ---- 互动按钮（点赞 / 投币 / 收藏 / 分享）---- */
.actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-top: 14px;
}
.act {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 34px;
  padding: 0 14px;
  border: none;
  border-radius: var(--md-sys-shape-corner-full);
  background: var(--md-sys-color-surface-container-high);
  color: var(--md-sys-color-on-surface);
  font-family: inherit;
  font-size: var(--md-sys-typescale-label-large-size);
  cursor: pointer;
  transition:
    background 160ms var(--md-sys-motion-spring-effects-fast),
    transform 200ms var(--md-sys-motion-spring-spatial-fast);
}
.act:hover:not(:disabled) {
  background: var(--md-sys-color-surface-container-highest);
}
.act:active:not(:disabled) {
  transform: scale(0.96);
}
.act:disabled {
  opacity: 0.5;
  cursor: default;
}
.act:focus-visible {
  outline: 2px solid var(--md-sys-color-primary);
  outline-offset: 2px;
}
/* 已激活（已赞 / 已投币 / 已收藏）：走主色容器，一眼能看出状态 */
.act.on {
  background: var(--md-sys-color-primary-container);
  color: var(--md-sys-color-on-primary-container);
}
.act .material-symbols-outlined {
  font-size: 18px;
}

.act-wrap {
  position: relative;
}
.coin-pop {
  position: absolute;
  left: 0;
  bottom: calc(100% + 8px);
  z-index: 5;
  display: flex;
  flex-direction: column;
  min-width: 132px;
  padding: 6px;
  border: 1px solid var(--lm-hairline);
  border-radius: var(--md-sys-shape-corner-medium);
  box-shadow: var(--md-elevation-3);
}
.coin-opt {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border: none;
  border-radius: var(--md-sys-shape-corner-small);
  background: transparent;
  color: var(--md-sys-color-on-surface);
  font-family: inherit;
  font-size: var(--md-sys-typescale-body-medium-size);
  text-align: left;
  cursor: pointer;
}
.coin-opt:hover {
  background: var(--md-sys-color-surface-container-high);
}
.coin-opt .material-symbols-outlined {
  font-size: 18px;
  color: var(--md-sys-color-primary);
}
.coin-pop-enter-active,
.coin-pop-leave-active {
  transition:
    opacity 120ms var(--md-sys-motion-spring-effects-fast),
    transform 200ms var(--md-sys-motion-spring-spatial-fast);
}
.coin-pop-enter-from,
.coin-pop-leave-to {
  opacity: 0;
  transform: translateY(4px);
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
.owner-link {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
  padding: 4px 10px 4px 4px;
  border: none;
  border-radius: var(--md-sys-shape-corner-full);
  background: transparent;
  color: inherit;
  font-family: inherit;
  text-align: left;
  cursor: pointer;
  transition: background 160ms var(--md-sys-motion-spring-effects-fast);
}
.owner-link:hover:not(:disabled) {
  background: var(--md-sys-color-surface-container-high);
}
.owner-link:disabled {
  cursor: default;
}
.owner-link:focus-visible {
  outline: 2px solid var(--md-sys-color-primary);
  outline-offset: 2px;
}
.owner-name {
  font-size: var(--md-sys-typescale-body-medium-size);
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.owner-link .go {
  font-size: 18px;
  color: var(--md-sys-color-on-surface-variant);
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

.detail-error {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 18px;
  color: var(--md-sys-color-error);
}
</style>
