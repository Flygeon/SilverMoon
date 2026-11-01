<script setup lang="ts">
/**
 * 媒体内容卡片外壳：m3e-card 托底 + 封面满铺。
 *
 * 为什么用官方 m3e-card 而不是自绘：
 * - 卡片托底、圆角、hover/focus/pressed 状态层、ripple、焦点环、海拔
 *   全部由 @m3e/web 提供，和设计系统保持同一套 token；
 *   自绘这些状态就是模仿 MD3，不是 MD3（见 SPEC §2.2 官方组件优先）。
 * - actionable 由组件自己管理 tabindex / 键盘激活 / :focus-visible，
 *   不需要再手写原生 button（design guard 的 CONTENT_CARDS 白名单也就此退出）。
 *
 * 取色：--m3e-filled-card-container-color 默认取 surfaceContainerHighest，
 * 在浅色与深色主题下都可能与页面底色过于接近或过于抢眼。这里显式对齐项目令牌
 * --lm-card-surface，让它「托得住」封面又不喧宾夺主。
 *
 * 文字：参考图的卡片只有封面。标题仍作为 aria-label / title 保留，
 * 供读屏与悬停提示使用，只是不渲染成可见文本。
 */
import { computed, ref } from "vue";

const props = withDefaults(
  defineProps<{
    title: string;
    cover?: string;
    /** 封面纵横比；`portrait` = 3/4，`square` = 1，也可传具体比例如 `16/9` */
    aspect?: "portrait" | "square" | (string & {});
    referrerpolicy?: ReferrerPolicy;
  }>(),
  { cover: "", aspect: "portrait", referrerpolicy: undefined },
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
  </m3e-card>
</template>

<style scoped>
/*
 * 卡片本体：m3e-card 是自定义元素，:host 默认 display:block、.base 是 flex 容器。
 * 这里只收紧内部留白（组件默认 --m3e-card-padding = space200，对纯封面卡片过厚）
 * 与取色，不改它的任何状态逻辑。
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
</style>
