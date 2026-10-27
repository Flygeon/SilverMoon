<script setup lang="ts">
/**
 * B 站视频卡片（16:9 封面 + 时长角标 + 标题 + UP 主 + 播放/弹幕数）。
 *
 * 与 AnimeCard 同一套观感骨架：透明按钮容器、封面走 --lm-shape-card 圆角 +
 * 发丝描边、hover 上浮。封面来自 i0.hdslb.com，防盗链 Referer 由主进程
 * webRequest 统一补（见 electron/net-headers.ts）。
 *
 * 封面加载策略：
 * - **骨架屏占位**：图片解码完成前显示 .lm-skeleton 微光块（与 MediaGrid 同一套
 *   骨架屏基元），而不是灰底空等；
 * - **提前两行预取**：IntersectionObserver + rootMargin 下扩 400px，滚到之前就开下；
 * - 失败时退回 smart_display 图标（与「本来就没有封面」表现一致）。
 */
import { computed } from "vue";
import { useSettingsStore } from "@/stores/settings";
import { useLazyCover } from "@/composables/useLazyCover";
import { COVER_FALLBACK_DATA_URL, toCoverProxyUrl } from "@/utils/onlineCache";
import { biliCount, biliDuration, type BiliVideo } from "@/utils/bilibili";
import { translate } from "@shared/i18n";

const props = defineProps<{ video: BiliVideo }>();

const settings = useSettingsStore();
const t = (key: string) => translate(settings.lang, key);
defineEmits<{ (e: "open", video: BiliVideo): void }>();

/*
 * 解构出来而不是保留 cover.xxx：<script setup> 只对**顶层** ref 做模板自动解包，
 * 嵌套在对象里的 ref 在模板中必须写 .value，容易漏；而且 ref="xxx" 也只能绑到
 * 顶层变量。
 */
const {
  el: coverRoot,
  shouldLoad,
  loaded: coverLoaded,
  failed: coverFailed,
  onLoad: onCoverLoad,
  onError: onCoverError,
} = useLazyCover();

/**
 * 真正写进 <img src> 的地址。
 *
 * 走 app-cover:// 代理（主进程统一补 Referer + 磁盘缓存 + 并发去重），
 * 与音乐封面同一套设施；失败时换成内联占位图，不再出现裂图。
 */
const coverSrc = computed(() =>
  coverFailed.value || !props.video.cover
    ? COVER_FALLBACK_DATA_URL
    : toCoverProxyUrl(props.video.cover),
);

/** 骨架屏只在「该加载了但还没解码完」时显示 */
const showSkeleton = computed(() => shouldLoad.value && !coverLoaded.value && !!props.video.cover);
</script>

<template>
  <button ref="coverRoot" type="button" class="bili-card" @click="$emit('open', video)">
    <div class="cover">
      <!-- 骨架屏：图片解码前铺一层微光块，尺寸由 .cover 的 16:9 决定，不会跳版 -->
      <div v-if="showSkeleton" class="lm-skeleton cover-skeleton"></div>
      <img
        v-if="video.cover && shouldLoad"
        :src="coverSrc"
        :alt="video.title"
        decoding="async"
        referrerpolicy="no-referrer"
        :class="{ 'is-loaded': coverLoaded }"
        @load="onCoverLoad"
        @error="onCoverError"
      />
      <span v-else-if="!video.cover" class="material-symbols-outlined placeholder"
        >smart_display</span
      >
      <span v-if="video.duration > 0" class="duration tabular-nums">{{
        biliDuration(video.duration)
      }}</span>
      <span v-if="video.reason" class="reason">{{ video.reason }}</span>
    </div>

    <div class="meta">
      <div class="title" :title="video.title">{{ video.title }}</div>
      <div class="up" :title="video.ownerName">
        <span class="material-symbols-outlined">person</span>
        <span class="up-name">{{ video.ownerName || t("bili.unknownUp") }}</span>
      </div>
      <div class="stats tabular-nums">
        <span class="stat">
          <span class="material-symbols-outlined">play_arrow</span>{{ biliCount(video.view) }}
        </span>
        <span class="stat">
          <span class="material-symbols-outlined">subtitles</span>{{ biliCount(video.danmaku) }}
        </span>
      </div>
    </div>
  </button>
</template>

<style scoped>
.bili-card {
  display: flex;
  flex-direction: column;
  gap: var(--lm-layout-control-gap);
  padding: 0;
  border: none;
  background: transparent;
  color: inherit;
  font-family: inherit;
  text-align: left;
  cursor: pointer;
  outline: none;
}
.bili-card:focus-visible {
  outline: var(--lm-focus-width) solid var(--lm-focus-color);
  outline-offset: var(--lm-space-4);
  border-radius: var(--lm-shape-card);
}

.cover {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  aspect-ratio: 16 / 9;
  border-radius: var(--lm-shape-card);
  overflow: hidden;
  background: var(--md-sys-color-surface-container);
  box-shadow: inset 0 0 0 1px var(--lm-hairline);
  color: var(--md-sys-color-outline);
  transition:
    transform var(--lm-motion-card) var(--md-sys-motion-spring-soft),
    box-shadow var(--lm-motion-card) var(--md-sys-motion-spring-effects-fast);
}
.bili-card:hover .cover {
  transform: translateY(-4px) scale(1.015);
  box-shadow:
    var(--md-elevation-3),
    inset 0 0 0 1px var(--lm-hairline);
}
.bili-card:active .cover {
  transform: translateY(-1px) scale(0.995);
}
.cover img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  /*
   * 淡入：图片解码完成的那一帧才把 opacity 提到 1。
   * 骨架屏在它下面（同一块 cover 容器），所以这里不需要 z-index —— 先画的
   * skeleton 会被后画的 img 覆盖，img 透明时露出的正是它。
   */
  opacity: 0;
  transition: opacity 220ms var(--md-sys-motion-spring-effects-fast);
}
.cover img.is-loaded {
  opacity: 1;
}

/* 骨架屏：铺满 16:9 封面区，圆角由父级 overflow:hidden 裁掉 */
.cover-skeleton {
  position: absolute;
  inset: 0;
}
.placeholder {
  font-size: 36px;
}

.duration {
  position: absolute;
  right: 6px;
  bottom: 6px;
  padding: 1px 6px;
  border-radius: var(--md-sys-shape-corner-extra-small);
  background: var(--lm-content-overlay-surface);
  color: var(--lm-content-overlay-color);
  font-size: 11px;
  line-height: 16px;
}

.reason {
  position: absolute;
  left: 6px;
  bottom: 6px;
  max-width: calc(100% - 64px);
  padding: 1px 7px;
  border-radius: var(--md-sys-shape-corner-full);
  background: color-mix(in srgb, var(--md-sys-color-primary) 82%, transparent);
  color: var(--md-sys-color-on-primary);
  font-size: 11px;
  line-height: 16px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.meta {
  min-width: 0;
}
.title {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  font-size: var(--md-sys-typescale-body-medium-size);
  font-weight: 500;
  line-height: 1.3;
}
.up {
  display: flex;
  align-items: center;
  gap: 3px;
  margin-top: 4px;
  min-width: 0;
  font-size: var(--md-sys-typescale-body-small-size);
  color: var(--md-sys-color-on-surface-variant);
}
.up .material-symbols-outlined {
  font-size: 13px;
}
.up-name {
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.stats {
  display: flex;
  gap: 10px;
  margin-top: 2px;
  font-size: 11px;
  color: var(--md-sys-color-on-surface-variant);
}
.stat {
  display: inline-flex;
  align-items: center;
  gap: 2px;
}
.stat .material-symbols-outlined {
  font-size: 13px;
}
</style>
