<script setup lang="ts">
/** 开发验收入口，不进入正式导航，也不读取用户媒体。 */
import { computed, ref } from "vue";
import { cssTokensFromSeed, DEFAULT_SEED_COLOR } from "@shared/m3-theme";
import SearchField from "@/components/SearchField.vue";
import SelectField from "@/components/SelectField.vue";
import SegmentedTabs from "@/components/SegmentedTabs.vue";
import SettingRow from "@/components/SettingRow.vue";
import MediaCardShell from "@/components/MediaCardShell.vue";
import EmptyState from "@/components/EmptyState.vue";
import ModalSurface from "@/components/ModalSurface.vue";

const dark = ref(false);
const seed = ref(DEFAULT_SEED_COLOR);
const query = ref("");
const selected = ref("first");
const enabled = ref(false);
const modal = ref(false);
const submitted = ref(0);
const tokens = computed(() => cssTokensFromSeed(seed.value, dark.value));
const tabs = [
  { value: "first", label: "推荐" },
  { value: "second", label: "搜索 / Search" },
];
const states = ["empty", "search", "error", "offline", "auth"] as const;
</script>

<template>
  <main class="design-review" :style="tokens" :data-theme="dark ? 'dark' : 'light'">
    <h1>桌面设计语言 · 组件验收</h1>
    <p>开发样板；封面与文案为演示数据。Tab 检查焦点，系统减少动态效果检查动效降级。</p>
    <section class="review-controls" aria-label="预览主题">
      <m3e-button variant="tonal" @click="dark = !dark">浅色 / 深色</m3e-button>
      <m3e-button
        variant="outlined"
        @click="seed = seed === DEFAULT_SEED_COLOR ? '#346b48' : DEFAULT_SEED_COLOR"
        >默认 / 绿色种子</m3e-button
      >
      <span>{{ dark ? "Dark" : "Light" }} · {{ seed }}</span>
    </section>
    <section aria-label="搜索与按钮状态">
      <h2>搜索 / Hover / Focus / Disabled</h2>
      <SearchField
        v-model="query"
        placeholder="搜索 / Search media"
        clear-label="清除搜索 / Clear search"
        @submit="submitted++"
      />
      <p role="status">提交 {{ submitted }} 次 · {{ query || "尚未输入" }}</p>
      <div class="review-controls">
        <m3e-button variant="filled" @click="modal = true">打开弹层</m3e-button>
        <m3e-button variant="tonal">次要操作</m3e-button>
        <m3e-button variant="outlined">描边操作</m3e-button>
        <m3e-button variant="text">文本操作</m3e-button>
        <m3e-button disabled>不可用 / Disabled</m3e-button>
        <m3e-filter-chip selected>已选择</m3e-filter-chip>
        <m3e-filter-chip disabled>不可筛选</m3e-filter-chip>
      </div>
    </section>
    <section aria-label="分段与设置行">
      <h2>连通分段 / 长说明</h2>
      <SegmentedTabs v-model="selected" :tabs="tabs">
        <template #actions><m3e-button variant="text">刷新</m3e-button></template>
      </SegmentedTabs>
      <SelectField v-model="selected" label="选择分段 / Select segment" :options="tabs" />
      <m3e-list class="review-settings" variant="segmented">
        <m3e-list-item>
          <SettingRow
            label="长标签设置项 / A setting with a long localized description that must wrap"
            setting-key="review.enabled"
          >
            <m3e-switch
              :checked="enabled"
              aria-label="长标签设置项"
              @change="enabled = ($event.target as HTMLInputElement).checked"
            />
          </SettingRow>
        </m3e-list-item>
        <m3e-list-item>
          <SettingRow label="不可用设置 / Disabled setting">
            <m3e-switch disabled aria-label="不可用设置" />
          </SettingRow>
        </m3e-list-item>
      </m3e-list>
    </section>
    <section aria-label="媒体与占位">
      <h2>内容卡片 / 加载 / 缺图</h2>
      <div class="review-grid">
        <MediaCardShell title="番剧封面占位" subtitle="3:4 · 长标题单行截断" icon="movie" />
        <MediaCardShell
          title="小说封面加载失败"
          cover="data:image/png;base64,AA=="
          icon="menu_book"
        />
        <MediaCardShell title="方形图片占位" aspect="square" icon="image" />
        <div class="lm-skeleton review-skeleton" role="status" aria-label="正在加载"></div>
      </div>
    </section>
    <section aria-label="空错误离线授权状态" class="review-states">
      <EmptyState
        v-for="state in states"
        :key="state"
        :variant="state"
        :title="state"
        description="说明当前状态与可执行的下一步 / Description and next action"
        action-label="重试 / Retry"
      />
    </section>
    <Teleport to="body">
      <div
        v-if="modal"
        class="review-backdrop"
        :style="tokens"
        :data-theme="dark ? 'dark' : 'light'"
      >
        <ModalSurface class="review-modal" label="弹层焦点验收" @close="modal = false">
          <h2>弹层焦点验收</h2>
          <p>Tab / Shift+Tab 保持在面板内；Escape 关闭后回到触发按钮。</p>
          <m3e-button @click="modal = false">关闭 / Close</m3e-button>
          <m3e-button variant="text">第二个焦点 / Second focus</m3e-button>
        </ModalSurface>
      </div>
    </Teleport>
  </main>
</template>

<style scoped>
.design-review {
  min-width: 0;
  padding: var(--lm-content-pad);
  background: var(--md-sys-color-surface);
  color: var(--md-sys-color-on-surface);
}
h1 {
  font-size: var(--md-sys-typescale-title-large-size);
}
h2 {
  font-size: var(--md-sys-typescale-title-medium-size);
}
section {
  margin-block: var(--lm-layout-group-gap);
}
p {
  color: var(--lm-text-secondary);
  overflow-wrap: anywhere;
}
.review-controls {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--lm-layout-control-gap);
}
.review-grid,
.review-states {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 180px), 1fr));
  gap: var(--lm-layout-grid-row-gap) var(--lm-layout-grid-column-gap);
}
.review-skeleton {
  aspect-ratio: 3 / 4;
  border-radius: var(--lm-shape-card);
}
.review-settings {
  --m3e-segmented-list-container-shape: var(--lm-settings-group-radius);
  --m3e-segmented-list-segment-gap: var(--lm-settings-item-gap);
  --m3e-segmented-list-item-container-shape: var(--lm-settings-item-radius);
  --m3e-segmented-list-item-container-color: var(--md-sys-color-surface-container-low);
}
.review-backdrop {
  position: fixed;
  inset: 0;
  z-index: var(--lm-layer-overlay);
  display: grid;
  place-items: center;
  padding: var(--lm-content-pad);
  background: var(--lm-overlay-scrim);
}
.review-modal {
  display: block;
  max-width: 100%;
  padding: var(--lm-space-24);
  border-radius: var(--lm-shape-dialog);
  background: var(--md-sys-color-surface-container-high);
  color: var(--md-sys-color-on-surface);
}
</style>
