<script setup lang="ts">
/**
 * B 站视频卡片：m3e-card 托底 + 16:9 封面。
 *
 * 为什么用官方 m3e-card 而不是自绘容器（与 MediaCardShell / MediaGrid 同一决定）：
 * 托底色、圆角、hover/focus/pressed 状态层、ripple、焦点环都来自 @m3e/web，
 * 与设计系统共用一套 token；自绘这些状态就是模仿 MD3，不是 MD3。
 *
 * 观感与其它媒体卡片统一：**只有封面**。标题 / UP 主 / 播放数不再渲染成可见文字，
 * 标题保留在 aria-label 上供读屏使用。
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
import { biliDuration, type BiliVideo } from "@/utils/bilibili";
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
        referrerpolicy="no-referrer"
        :class="{ 'is-loaded': coverLoaded }"
        @load="onCoverLoad"
        @error="onCoverError"
      />
      <span v-else-if="!video.cover" class="material-symbols-outlined placeholder"
        >smart_display</span
      >
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

/* 骨架屏：铺满 16:9 封面区，圆角由父级 overflow:hidden 裁掉 */
.cover-skeleton {
  position: absolute;
  inset: 0;
}
.placeholder {
  font-size: 36px;
}
</style>
