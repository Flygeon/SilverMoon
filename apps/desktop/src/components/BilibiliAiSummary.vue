<script setup lang="ts">
/**
 * AI 视频总结面板（视频详情页内联展开）。
 *
 * 纯展示组件：只渲染 store 已经拿到的结论，不自己发请求、不持有加载状态。
 * 拉取由 BilibiliVideoView 触发，这样「同一份结论」将来在别处复用也不必重写请求逻辑。
 */
import type { BiliAiConclusion } from "@/utils/bilibili";
import { useSettingsStore } from "@/stores/settings";
import { translate } from "@shared/i18n";

defineProps<{
  summary: BiliAiConclusion | null;
  /** store 里的错误文案（未登录 / 上游失败 / 暂不支持） */
  error?: string;
  /** 正在拉取（按钮已禁用，这里给面板一个占位，避免看成「没有总结」） */
  loading?: boolean;
}>();

const emit = defineEmits<{ (e: "seek", seconds: number): void }>();

const settings = useSettingsStore();
const t = (key: string) => translate(settings.lang, key);

/** 秒 → m:ss（章节按钮上的时间刻度，与播放器进度条口径一致）。 */
function fmtClock(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
</script>

<template>
  <section class="ai-panel">
    <div v-if="loading" class="ai-state">
      <m3e-loading-indicator class="lm-loading" />
      <span>{{ t("bili.aiSummaryLoading") }}</span>
    </div>

    <p v-else-if="error" class="ai-error">
      <span class="material-symbols-outlined">error</span>
      {{ error }}
    </p>

    <p v-else-if="!summary || (!summary.summary && !summary.outline.length)" class="ai-state">
      {{ t("bili.aiSummaryEmpty") }}
    </p>

    <template v-else>
      <template v-if="summary.summary">
        <h4 class="ai-label">{{ t("bili.aiSummarySummary") }}</h4>
        <p class="ai-summary">{{ summary.summary }}</p>
      </template>

      <template v-if="summary.outline.length">
        <h4 class="ai-label">{{ t("bili.aiSummaryOutline") }}</h4>
        <ol class="ai-outline">
          <li v-for="(section, i) in summary.outline" :key="i" class="ai-section">
            <div class="ai-section-title">{{ section.title || `#${i + 1}` }}</div>
            <ul class="ai-parts">
              <li v-for="(part, j) in section.parts" :key="j">
                <!-- 点章节直接跳播放位置：AI 总结最常见的用法是「挑着看」 -->
                <button
                  class="ai-part"
                  type="button"
                  :title="t('bili.aiSummaryOpen')"
                  @click="emit('seek', part.timestamp)"
                >
                  <span class="ai-ts tabular-nums">{{ fmtClock(part.timestamp) }}</span>
                  <span class="ai-part-text">{{ part.content }}</span>
                </button>
              </li>
            </ul>
          </li>
        </ol>
      </template>
    </template>
  </section>
</template>

<style scoped>
.ai-panel {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 14px 16px;
  border-radius: var(--lm-shape-card);
  background: var(--md-sys-color-surface-container-low);
  box-shadow: inset 0 0 0 1px var(--lm-hairline);
}

.ai-state {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0;
  font-size: var(--md-sys-typescale-body-small-size);
  color: var(--md-sys-color-on-surface-variant);
}

.ai-error {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0;
  font-size: var(--md-sys-typescale-body-small-size);
  color: var(--md-sys-color-error);
}
.ai-error .material-symbols-outlined {
  font-size: 16px;
}

.ai-label {
  margin: 4px 0 0;
  font-size: var(--md-sys-typescale-label-large-size);
  font-weight: 500;
  color: var(--md-sys-color-primary);
}
.ai-summary {
  margin: 0;
  font-size: var(--md-sys-typescale-body-medium-size);
  line-height: 1.7;
  white-space: pre-wrap;
  word-break: break-word;
}

.ai-outline {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.ai-section-title {
  margin-bottom: 4px;
  font-size: var(--md-sys-typescale-body-small-size);
  font-weight: 500;
  color: var(--md-sys-color-on-surface-variant);
}
.ai-parts {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.ai-part {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  width: 100%;
  padding: 4px 6px;
  border: none;
  border-radius: var(--md-sys-shape-corner-small);
  background: transparent;
  color: var(--md-sys-color-on-surface);
  font-family: inherit;
  font-size: var(--md-sys-typescale-body-small-size);
  line-height: 1.6;
  text-align: left;
  cursor: pointer;
  transition: background 160ms var(--md-sys-motion-spring-effects-fast);
}
.ai-part:hover {
  background: var(--md-sys-color-surface-container-highest);
}
.ai-ts {
  flex: none;
  padding: 0 6px;
  border-radius: var(--md-sys-shape-corner-full);
  background: var(--md-sys-color-secondary-container);
  color: var(--md-sys-color-on-secondary-container);
  font-size: 11px;
  line-height: 18px;
}
.ai-part-text {
  min-width: 0;
  word-break: break-word;
}
</style>
