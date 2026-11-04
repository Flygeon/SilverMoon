<script setup lang="ts">
/**
 * B 站视频卡片：m3e-card 托底 + 16:9 封面。
 *
 * 为什么用官方 m3e-card 而不是自绘容器（与 MediaCardShell / MediaGrid 同一决定）：
 * 托底色、圆角、hover/focus/pressed 状态层、ripple、焦点环都来自 @m3e/web，
 * 与设计系统共用一套 token；自绘这些状态就是模仿 MD3，不是 MD3。
 *
 * 观感：封面 + 标题 + UP 主 + 播放/弹幕数，官方 m3e-card 托底。
 * B 站卡片必须保留文字 —— 只凭封面无法分辨视频。
 *
 * 封面加载策略（保留原有实现）：
 * - **骨架屏占位**：图片解码完成前铺 .lm-skeleton 微光块，而不是灰底空等；
 * - **提前两行预取**：IntersectionObserver + rootMargin 下扩 400px；
 * - 失败时退回内联占位图，不再出现裂图。
 * 封面走 app-cover:// 代理（主进程统一补 Referer + 磁盘缓存 + 并发去重）。
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
 * 失败时换成内联占位图，不再出现裂图。
 */
const coverSrc = computed(() =>
  coverFailed.value || !props.video.cover
    ? COVER_FALLBACK_DATA_URL
    : toCoverProxyUrl(props.video.cover),
);

/** 骨架屏只在「该加载了但还没解码完」时显示 */
const showSkeleton = computed(() => shouldLoad.value && !coverLoaded.value && !!props.video.cover);

/** 读屏与悬停提示：标题 + UP 主 + 时长，视觉上不渲染 */
const label = computed(() => {
  const parts = [props.video.title, props.video.ownerName || t("bili.unknownUp")];
  if (props.video.duration > 0) parts.push(biliDuration(props.video.duration));
  return parts.filter(Boolean).join(" · ");
});
</script>

<template>
  <m3e-card
    ref="coverRoot"
    class="bili-card"
    variant="filled"
    actionable
    :aria-label="label"
    :title="label"
    @click="$emit('open', video)"
  >
    <!-- 官方 m3e-card 的 header 槽（原生 slot 属性是 Web Components 的约定写法） -->
    <div slot="header" class="cover">
      <!-- 骨架屏：图片解码前铺一层微光块，尺寸由 .cover 的 16:9 决定，不会跳版 -->
      <div v-if="showSkeleton" class="lm-skeleton cover-skeleton"></div>
      <img
        v-if="video.cover && shouldLoad"
        :src="coverSrc"
        :alt="video.title"
        decoding="async"
        draggable="false"
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

    <!-- 文字区：与官方 m3e-card 的 content 槽配合，构成标准 MD3 卡片 -->
    <div slot="content" class="meta">
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
  </m3e-card>
</template>

<style scoped>
/*
 * 卡片本体是 m3e-card：宿主元素默认 display:block。
 * 取色与留白通过组件 token 注入，与 MediaCardShell / MediaGrid 完全一致，
 * 三处共用 --lm-card-surface，避免各写一套导致色差。
 */
.bili-card {
  --m3e-card-padding: 0;
  --m3e-card-shape: var(--lm-shape-card);
  --m3e-card-container-color: var(--lm-card-surface);
  --m3e-filled-card-container-color: var(--lm-card-surface);
  --m3e-filled-card-hover-state-layer-color: var(--lm-card-surface-hover);
  --m3e-filled-card-hover-state-layer-opacity: 0.5;
  display: block;
  width: 100%;
  overflow: hidden;
  border-radius: var(--lm-shape-card);
  transition: transform var(--lm-motion-card) var(--md-sys-motion-spring-soft);
}
.bili-card:hover {
  transform: translateY(-4px);
}
.bili-card:active {
  transform: translateY(-1px);
}
@media (prefers-reduced-motion: reduce) {
  .bili-card,
  .bili-card:hover,
  .bili-card:active {
    transform: none;
    transition: none;
  }
}

.cover {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  aspect-ratio: 16 / 9;
  overflow: hidden;
  background: var(--lm-media-placeholder-surface);
  color: var(--lm-media-placeholder-color);
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

/* 时长角标：压在封面右下角 */
.duration {
  position: absolute;
  right: 6px;
  bottom: 6px;
  padding: var(--lm-space-2) var(--lm-space-4);
  border-radius: var(--md-sys-shape-corner-extra-small);
  background: var(--lm-content-overlay-surface);
  color: var(--lm-content-overlay-color);
  font-size: 11px;
  line-height: 16px;
}
/* 「限流/失效」等来源提示：压在封面左下角 */
.reason {
  position: absolute;
  left: 6px;
  bottom: 6px;
  max-width: calc(100% - 64px);
  padding: var(--lm-space-2) var(--lm-space-8);
  border-radius: var(--md-sys-shape-corner-full);
  background: color-mix(in srgb, var(--md-sys-color-primary) 82%, transparent);
  color: var(--md-sys-color-on-primary);
  font-size: 11px;
  line-height: 16px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 文字区：content 槽的 padding 已被清零，这里自己给内边距 */
.meta {
  padding: var(--lm-space-8) var(--lm-space-12) var(--lm-space-12);
}
.meta .title {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  font-size: var(--md-sys-typescale-body-medium-size);
  font-weight: 500;
  line-height: 1.35;
  color: var(--md-sys-color-on-surface);
}
.up {
  display: flex;
  align-items: center;
  gap: var(--lm-space-2);
  margin-top: var(--lm-space-4);
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
  gap: var(--lm-space-8);
  margin-top: var(--lm-space-2);
  font-size: 11px;
  color: var(--md-sys-color-on-surface-variant);
}
.stat {
  display: inline-flex;
  align-items: center;
  gap: var(--lm-space-2);
}
.stat .material-symbols-outlined {
  font-size: 13px;
}

/* 骨架屏：铺满 16:9 封面区，圆角由父级 overflow:hidden 裁掉 */
.cover-skeleton {
  position: absolute;
  inset: 0;
}
.placeholder {
  font-size: 36px;
}
</style>
