<script setup lang="ts">
/**
 * 媒体内容卡片外壳：m3e-card 托底 + 封面 + 文字区。
 *
 * 为什么用官方 m3e-card 而不是自绘：
 * - 卡片托底、圆角、hover/focus/pressed 状态层、ripple、焦点环、海拔
 *   全部由 @m3e/web 提供，和设计系统保持同一套 token；
 *   自绘这些状态就是模仿 MD3，不是 MD3（见 SPEC §2.2 官方组件优先）。
 * - actionable 由组件自己管理 tabindex / 键盘激活 / :focus-visible，
 *   不需要再手写原生 button。
 *
 * 结构：封面放 header 槽（满铺、无内边距），文字放 content 槽。
 * m3e-card 的 padding 是以 margin 形式加在 content 槽上的（header 只有水平 margin），
 * 所以把 --m3e-card-padding 置 0、再由 .meta 自己给内边距，
 * 就能做到「封面满铺 + 文字有 MD3 呼吸感」。
 *
 * 谁有文字：动漫 / B站 / 音乐 / 书籍 用默认 meta=true 显示标题与副标题；
 * 图片 / 视频 是纯封面墙，传 :meta="false"。
 *
 * 取色：--m3e-filled-card-container-color 默认取 surfaceContainerHighest，
 * 与页面底色拉不开。这里显式对齐项目令牌 --lm-card-surface。
 */
import { computed, ref } from "vue";

const props = withDefaults(
  defineProps<{
    title: string;
    cover?: string;
    /** 副标题（作者 / 集数 / 进度…），不传则只显示标题 */
    subtitle?: string;
    /** 是否显示文字区；图片/视频这类纯封面卡片传 false */
    meta?: boolean;
    /** 封面纵横比；`portrait` = 3/4，`square` = 1，也可传具体比例如 `16/9` */
    aspect?: "portrait" | "square" | (string & {});
    referrerpolicy?: ReferrerPolicy;
  }>(),
  { cover: "", subtitle: "", meta: true, aspect: "portrait", referrerpolicy: undefined },
);
defineEmits<{ open: [event: MouseEvent] }>();

const failedCover = ref<string | null>(null);
const showCover = computed(() => !!props.cover && failedCover.value !== props.cover);
/** named aspect → CSS aspect-ratio 值 */
const ratio = computed(() => {
  if (props.aspect === "portrait") return "3 / 4";
  if (props.aspect === "square") return "1";
  return props.aspect;
});
</script>

<template>
  <m3e-card
    class="media-card"
    :class="{ 'is-meta': meta }"
    variant="filled"
    actionable
    :aria-label="title"
    @click="$emit('open', $event)"
  >
    <!-- 官方 m3e-card 的 header 槽（原生 slot 属性是 Web Components 的约定写法） -->
    <div slot="header" class="cover" :style="{ aspectRatio: ratio }">
      <img
        v-if="showCover"
        :key="cover"
        :src="cover"
        :alt="title"
        loading="lazy"
        decoding="async"
        :referrerpolicy="referrerpolicy"
        @error="failedCover = cover"
      />
      <span v-else class="material-symbols-outlined fallback" aria-hidden="true">image</span>
      <slot name="cover-overlay" />
    </div>

    <div v-if="meta" slot="content" class="meta">
      <div class="title" :title="title">{{ title }}</div>
      <slot name="metadata">
        <div v-if="subtitle" class="sub" :title="subtitle">{{ subtitle }}</div>
      </slot>
    </div>
  </m3e-card>
</template>

<style scoped>
/*
 * 卡片本体：m3e-card 是自定义元素，:host 默认 display:block、.base 是 flex 容器。
 * padding 置 0 让封面满铺，文字区自己给内边距。
 */
.media-card {
  --m3e-card-padding: 0;
  --m3e-card-shape: var(--lm-shape-card);
  --m3e-card-container-color: var(--lm-card-surface);
  --m3e-filled-card-container-color: var(--lm-card-surface);
  /*
   * 悬停取色：filled variant 没有暴露 hover 的 container-color token，只有状态层。
   * 用状态层叠加做层次变化 —— 这正是 MD3 规范的做法（状态层而非换底色），
   * 比自己写 :hover 底色更正统，也不会覆盖 m3e 的 focus / pressed 状态。
   */
  --m3e-filled-card-hover-state-layer-color: var(--lm-card-surface-hover);
  --m3e-filled-card-hover-state-layer-opacity: 0.5;
  display: block;
  width: 100%;
  overflow: hidden;
  border-radius: var(--lm-shape-card);
}
.cover {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  overflow: hidden;
  background: var(--lm-media-placeholder-surface);
  color: var(--lm-media-placeholder-color);
}
.cover img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.fallback {
  font-size: 36px;
}

/* 文字区：与封面同宽，内边距按 MD3 的 8/12 节奏，不挤压封面 */
.meta {
  padding: var(--lm-space-8) var(--lm-space-12) var(--lm-space-12);
}
.title {
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
.sub {
  margin-top: var(--lm-space-2);
  font-size: var(--md-sys-typescale-body-small-size);
  color: var(--md-sys-color-on-surface-variant);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>
