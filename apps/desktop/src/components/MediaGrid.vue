<script setup lang="ts">
/**
 * 媒体网格：图片/视频/音乐/书籍四个列表页共用。
 *
 * 大图库性能策略（三层）：
 * 1. 虚拟滚动——只渲染可视区 ±2 行的卡片，DOM 节点数恒定，
 *    不随库容量增长（此前上万张图会创建上万个节点，直接卡死）。
 * 2. 缩略图按可视区批量请求，滚动过快时丢弃过期批次。
 * 3. 缩略图是 asset:// 路径而非 base64，内存由 webview 回收。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useLibraryStore } from "@/stores/library";
import { useSettingsStore } from "@/stores/settings";
import { useDesktopStore } from "@/stores/desktop";
import { capabilities } from "@/capabilities";
import { openContextMenu, type MenuItem } from "@/composables/useContextMenu";
import { localTagTarget, openMusicTagDialog } from "@/composables/useMusicTagDialog";
import { TYPE_ICONS, formatDuration, formatResolution, formatSize } from "@/utils/format";
import { translate } from "@shared/i18n";
import { masonryLayout, mediaAspect } from "@/utils/mediaLayout";
import type { MediaEntry, WallpaperMode } from "@shared/types";

const props = withDefaults(
  defineProps<{
    items: MediaEntry[];
    /** 卡片纵横比：1 方形（图片/音乐）、16/9 视频、3/4 书籍 */
    aspect?: string;
    /** 卡片最小宽度，决定每行列数 */
    minWidth?: number;
    /**
     * 副标题字段来源。
     * 图片 / 视频页传 "none" 且 meta=false —— 纯封面墙；
     * 音乐 / 书籍 / 回收站 / 历史等传具体字段，卡片带文字与 MD3 托底。
     */
    subtitle?: "artist" | "resolution" | "size" | "none";
    /** 是否显示文字区（标题 + 副标题）。图片/视频为 false */
    meta?: boolean;
    loading?: boolean;
    skeletonCount?: number;
    masonry?: boolean;
    list?: boolean;
    selecting?: boolean;
    selectedIds?: string[];
  }>(),
  {
    aspect: "1",
    minWidth: 180,
    subtitle: "none",
    meta: true,
    loading: false,
    skeletonCount: 12,
    masonry: false,
    list: false,
    selecting: false,
    selectedIds: () => [],
  },
);

const emit = defineEmits<{
  (e: "open", item: MediaEntry, index: number): void;
  (e: "favorite", item: MediaEntry): void;
}>();

const library = useLibraryStore();
const settings = useSettingsStore();
const desktopEnv = useDesktopStore();

/** 页内提示（壁纸设置成功 / 失败），与音乐页同样式的轻量 toast */
const toast = ref("");
let toastTimer: number | null = null;

function flash(message: string) {
  toast.value = message;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (toast.value = ""), 2600);
}

function t(key: string) {
  return translate(settings.lang, key);
}

/**
 * 右键卡片菜单。
 *
 * 网格是所有媒体类型共用的，因此菜单按类型给：
 * - 音频多一个「写音乐标签」——本地音乐的网格视图此前没有任何写标签入口
 *   （列表视图 TrackList 有），用户右键本地歌曲找不到那个选项，就是这个缺口。
 * - 图片多一个「设为壁纸」二级菜单（UDA）。四种填充模式做成子项而不是
 *   「点了再弹选择框」，是因为这个操作天然是「选一种模式」，
 *   做成子菜单一步到位，也不打断右键菜单的交互节奏。
 */
function onContextMenu(e: MouseEvent, item: MediaEntry) {
  const items: MenuItem[] = [
    { id: "reveal", label: t("context.revealInExplorer"), icon: "folder_open" },
  ];
  // 只给**在位**的音频：回收站里的条目文件可能已被删，写标签必然失败；
  // 那个页面也不是写标签的场景（要写也得先还原）。
  if (item.type === "audio" && !item.deleted) {
    items.push({ id: "write-tags", label: t("musicTag.menu"), icon: "sell" });
  }
  // 只给**在位**的图片：壁纸后端要读真实文件，回收站条目可能已被删。
  // 平台不支持时（capabilities.canWallpaper 为 false）连菜单都不出现，
  // 而不是点了才报错。
  if (item.type === "image" && !item.deleted && desktopEnv.canWallpaper) {
    items.push({
      id: "wallpaper",
      label: t("context.setAsWallpaper"),
      icon: "wallpaper",
      children: (
        [
          ["crop", "context.wallpaperCrop"],
          ["fill", "context.wallpaperFill"],
          ["fit", "context.wallpaperFit"],
          ["stretch", "context.wallpaperStretch"],
        ] as const
      ).map(([mode, key]) => ({
        id: `wallpaper:${mode}`,
        label: t(key),
      })),
    });
  }
  openContextMenu(e, items, (id) => {
    if (id === "reveal") void capabilities.revealInExplorer(item.path);
    else if (id === "write-tags") openMusicTagDialog(localTagTarget(item));
    else if (id.startsWith("wallpaper:")) {
      void applyWallpaper(item, id.slice("wallpaper:".length) as WallpaperMode);
    }
  });
}

/** 应用壁纸并给出反馈：平台不支持时静默吞掉，后端报错才提示 */
async function applyWallpaper(item: MediaEntry, mode: WallpaperMode) {
  const ok = await desktopEnv.setWallpaper(item.path, mode);
  if (ok) {
    flash(t("context.wallpaperApplied"));
    return;
  }
  // lastError 为空 = 平台不支持（正常状态，不打扰用户）；
  // 有值 = 后端报错，原文已是人话，直接拼上展示。
  const reason = desktopEnv.lastError;
  if (reason) {
    flash(`${t("context.wallpaperFailed")}：${reason}`);
  }
}

/*
 * 间距：值来自 --lm-layout-grid-* 令牌（16 / 20），这里用常量是因为虚拟滚动
 * 需要在 JS 里按像素预知行高，读 CSS 变量会引入一次强制样式重算。
 */
const GAP_X = 16;
const GAP_Y = 20;
/**
 * 文字区高度（含卡片内边距与两行之间的间隔），只在 meta=true 时占用。
 * 纯封面卡片（图片 / 视频）为 0，行高与瀑布流都不再为文字让位。
 */
const META_H = 62;
/** 可视区上下各多渲染的行数，滚动时不留白 */
const OVERSCAN = 2;

const viewport = ref<HTMLElement | null>(null);
const scroller = ref<HTMLElement | null>(null);
const width = ref(0);
const scrollTop = ref(0);
const viewportH = ref(800);

const columns = computed(() =>
  Math.max(1, Math.floor((width.value + GAP_X) / (props.minWidth + GAP_X))),
);
const cellW = computed(() => (width.value - GAP_X * (columns.value - 1)) / columns.value);
/** 由 aspect（"16/9" 或 "1"）推算缩略图高度 */
const ratio = computed(() => {
  const [w, h] = props.aspect.split("/").map(Number);
  return h ? w / h : w || 1;
});
/** 文字区占用高度：纯封面卡片为 0 */
const metaH = computed(() => (props.meta ? META_H : 0));
const rowH = computed(() => cellW.value / ratio.value + metaH.value + GAP_Y);
const rowCount = computed(() => Math.ceil(props.items.length / columns.value));
/** 瀑布流的每格额外高度：同样按 meta 决定 */
const masonryMetrics = computed(() =>
  masonryLayout(props.items, width.value, props.minWidth, metaH.value),
);
const totalH = computed(() =>
  props.list
    ? props.items.length * 96
    : props.masonry
      ? masonryMetrics.value.height
      : rowCount.value * rowH.value,
);

const firstRow = computed(() => Math.max(0, Math.floor(scrollTop.value / rowH.value) - OVERSCAN));
const lastRow = computed(() =>
  Math.min(rowCount.value, Math.ceil((scrollTop.value + viewportH.value) / rowH.value) + OVERSCAN),
);

/** 当前需要渲染的条目及其全局索引 */
const visible = computed(() => {
  if (props.masonry || props.list) {
    const start = scrollTop.value - 600;
    const end = scrollTop.value + viewportH.value + 600;
    if (props.list) {
      return props.items
        .slice(Math.max(0, Math.floor(start / 96)), Math.ceil(end / 96))
        .map((item, i) => ({ item, index: Math.max(0, Math.floor(start / 96)) + i }));
    }
    return masonryMetrics.value.cells.filter(
      (cell) => cell.top + cell.height >= start && cell.top <= end,
    );
  }
  const start = firstRow.value * columns.value;
  const end = Math.min(props.items.length, lastRow.value * columns.value);
  const out: { item: MediaEntry; index: number }[] = [];
  for (let i = start; i < end; i++) {
    out.push({ item: props.items[i], index: i });
  }
  return out;
});

const offsetY = computed(() => (props.masonry || props.list ? 0 : firstRow.value * rowH.value));

// ---- 缩略图按可视区拉取 ----
let thumbTimer: number | null = null;
function scheduleThumbs() {
  if (thumbTimer !== null) return;
  // 合并高频滚动产生的请求
  thumbTimer = window.setTimeout(() => {
    thumbTimer = null;
    const ids = visible.value.map((v) => v.item.id);
    if (ids.length) void library.loadThumbnails(ids);
  }, 120);
}

watch(visible, scheduleThumbs, { immediate: true });

function onScroll() {
  const el = viewport.value;
  if (!el) return;
  const root = scroller.value;
  scrollTop.value = root
    ? Math.max(0, el.getBoundingClientRect().top - root.getBoundingClientRect().top)
    : 0;
}

let ro: ResizeObserver | null = null;

function measure() {
  const el = scroller.value;
  const vp = viewport.value;
  if (el) width.value = el.clientWidth;
  if (vp) viewportH.value = vp.clientHeight;
  onScroll();
}

function detach() {
  viewport.value?.removeEventListener("scroll", onScroll);
  ro?.disconnect();
  ro = null;
  viewport.value = null;
}

/**
 * 绑定滚动容器。必须在 scroller 真正出现后调用——首屏 loading 为 true 时
 * 渲染的是骨架屏分支，此时 scroller 为 null，若只在 onMounted 里绑定
 * 会永远拿不到滚动事件（虚拟窗口卡在第一屏）。
 */
function attach() {
  if (!scroller.value || viewport.value) return;
  viewport.value = scroller.value.closest(".main-content");
  if (!viewport.value) return;
  viewport.value.addEventListener("scroll", onScroll, { passive: true });
  ro = new ResizeObserver(measure);
  ro.observe(scroller.value);
  ro.observe(viewport.value);
  measure();
  onScroll();
}

watch(
  scroller,
  () => {
    detach();
    attach();
  },
  { flush: "post" },
);
onMounted(attach);
onBeforeUnmount(() => {
  detach();
  if (thumbTimer !== null) clearTimeout(thumbTimer);
  if (toastTimer !== null) clearTimeout(toastTimer);
});

// 换类型/重新搜索后回到顶部，否则会停在旧的滚动位置看到空白
watch(
  () => props.items,
  () => {
    if (viewport.value) viewport.value.scrollTop = 0;
    scrollTop.value = 0;
    measure();
  },
);

function cellStyle(index: number) {
  if (props.list)
    return { position: "absolute" as const, left: "0", top: `${index * 96}px`, width: "100%" };
  if (props.masonry) {
    const cell = masonryMetrics.value.cells[index];
    return {
      position: "absolute" as const,
      left: `${cell.left}px`,
      top: `${cell.top}px`,
      width: `${masonryMetrics.value.cellWidth}px`,
    };
  }
  const col = index % columns.value;
  const row = Math.floor(index / columns.value) - firstRow.value;
  return {
    position: "absolute" as const,
    left: `${col * (cellW.value + GAP_X)}px`,
    top: `${row * rowH.value}px`,
    width: `${cellW.value}px`,
  };
}

function thumbOf(item: MediaEntry): string | undefined {
  return item.thumbPath ? capabilities.thumbUrl(item.thumbPath) : library.getThumb(item.id);
}

/**
 * 副标题取哪个字段。
 * 图片 / 视频页用 meta=false 不显示文字，这里的返回值也就不会被渲染；
 * 音乐（artist）、书籍与回收站/历史（size / resolution）各自取所需。
 */
function subtitleOf(item: MediaEntry): string {
  switch (props.subtitle) {
    case "artist":
      return item.artist || "未知艺术家";
    case "resolution":
      return formatResolution(item.width, item.height) || formatSize(item.size);
    case "size":
      return formatSize(item.size);
    default:
      return item.durationMs ? formatDuration(item.durationMs) : "";
  }
}
</script>

<template>
  <div class="grid-host">
    <!-- 骨架屏：加载中用普通网格，数量固定不需要虚拟化 -->
    <div
      v-if="loading"
      class="skeleton-grid"
      :style="{ gridTemplateColumns: `repeat(auto-fill, minmax(${minWidth}px, 1fr))` }"
    >
      <div v-for="n in skeletonCount" :key="n" class="skeleton-cell">
        <div class="thumb lm-skeleton" :style="{ aspectRatio: aspect }"></div>
        <div v-if="meta" class="meta-skeleton">
          <div class="lm-skeleton line"></div>
          <div class="lm-skeleton line short"></div>
        </div>
      </div>
    </div>

    <div
      v-else
      ref="scroller"
      class="virtual-root"
      :class="{ 'mixed-grid': masonry, 'list-grid': list }"
      :style="{ height: totalH + 'px' }"
    >
      <div
        class="layer"
        :class="{ 'is-refreshing': library.refreshing }"
        :style="{ transform: `translateY(${offsetY}px)` }"
      >
        <!--
          卡片本体是官方 m3e-card（filled + actionable）：
          托底色、圆角、hover/focus/pressed 状态层、ripple、焦点环全部由组件提供，
          actionable 自己管理 tabindex 与键盘激活，不再需要外层原生 button/article。
          文字区按 meta 决定：图片 / 视频是纯封面墙，其余页面保留标题与副标题。
          header 槽用原生 slot 属性：这是向 Web Components 传具名插槽的约定写法，
          用 <template #header> 会让 @vue/compiler-core 的 codegen 崩溃（实测可复现）。
        -->
        <m3e-card
          v-for="v in visible"
          :key="v.item.id"
          class="cell media-tile"
          :class="{ selected: selectedIds.includes(v.item.id), 'has-meta': meta }"
          variant="filled"
          :orientation="list ? 'horizontal' : 'vertical'"
          actionable
          :aria-selected="selecting ? selectedIds.includes(v.item.id) : undefined"
          :aria-label="v.item.title || v.item.name"
          data-hero-source
          :style="cellStyle(v.index)"
          @click="emit('open', v.item, v.index)"
          @contextmenu="onContextMenu($event, v.item)"
        >
          <div
            slot="header"
            class="thumb"
            data-hero-cover
            :style="{ aspectRatio: list ? '1' : masonry ? String(mediaAspect(v.item)) : aspect }"
          >
            <span v-if="selecting" class="selection-mark material-symbols-outlined">{{
              selectedIds.includes(v.item.id) ? "check_circle" : "check_box_outline_blank"
            }}</span>
            <img
              v-if="thumbOf(v.item)"
              :src="thumbOf(v.item)"
              :alt="v.item.name"
              loading="lazy"
              decoding="async"
            />
            <span v-else class="placeholder material-symbols-outlined">
              {{ TYPE_ICONS[v.item.type] ?? "draft" }}
            </span>

            <div class="overlay" :class="{ pinned: v.item.favorite }" data-hero-skip>
              <m3e-icon-button
                v-if="!selecting"
                class="fav"
                :class="{ on: v.item.favorite }"
                :title="t(v.item.favorite ? 'context.unfavorite' : 'context.favorite')"
                :aria-label="t(v.item.favorite ? 'context.unfavorite' : 'context.favorite')"
                @click.stop="emit('favorite', v.item)"
                @keydown.stop
              >
                <span class="material-symbols-outlined" :class="{ filled: v.item.favorite }"
                  >favorite</span
                >
              </m3e-icon-button>
            </div>
          </div>

          <!--
            文字区：图片 / 视频页（meta=false）不渲染，保持纯封面墙；
            音乐 / 书籍 / 回收站 / 历史等显示标题与副标题，
            与官方 m3e-card 的托底色一起构成标准 MD3 卡片。
          -->
          <div v-if="meta" slot="content" class="meta">
            <div class="title" :title="v.item.name">
              {{ v.item.title || v.item.name }}
            </div>
            <div v-if="subtitle !== 'none'" class="subtitle">
              {{ subtitleOf(v.item) }}
            </div>
          </div>
        </m3e-card>
      </div>
    </div>

    <!-- 壁纸设置等操作的轻量回执；系统通知看不到时才靠它兜底 -->
    <div v-if="toast" class="grid-toast">{{ toast }}</div>
  </div>
</template>

<style scoped>
.grid-host {
  position: relative;
  display: contents;
}
/*
 * 轻量回执：贴在网格底部居中。
 * 用 fixed 而不是 absolute —— 网格本体是虚拟滚动的，
 * absolute 会随滚动卷走，用户点完壁纸可能看不到这条提示。
 */
.grid-toast {
  position: fixed;
  left: 50%;
  bottom: 28px;
  transform: translateX(-50%);
  z-index: var(--lm-layer-sticky);
  max-width: min(70vw, 520px);
  padding: 10px 18px;
  border-radius: var(--md-sys-shape-corner-full, 999px);
  background: var(--md-sys-color-inverse-surface);
  color: var(--md-sys-color-inverse-on-surface);
  font-size: var(--md-sys-typescale-body-medium-size);
  box-shadow: var(--md-sys-elevation-level3, 0 4px 12px rgb(0 0 0 / 30%));
  pointer-events: none;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.virtual-root {
  position: relative;
  width: 100%;
}
/*
 * 瀑布流单元格：m3e-card 的托底色由组件 token 提供，这里不能再写 background，
 * 否则会盖掉 filled variant 的取色（自定义元素宿主上的 background 优先级高于内部 .base）。
 */
.mixed-grid .cell {
  overflow: hidden;
}
.cell.selected {
  outline: 2px solid var(--md-sys-color-primary);
  outline-offset: 2px;
}
.selection-mark {
  position: absolute;
  left: 8px;
  top: 8px;
  z-index: 1;
  color: var(--md-sys-color-on-primary-container);
  background: var(--md-sys-color-primary-container);
  border-radius: var(--md-sys-shape-corner-full);
}
.mixed-grid .thumb {
  flex-shrink: 0;
  width: 100%;
}
/*
 * 列表视图：单行 80px 封面的紧凑排布。
 * 只设高度，不再写 background —— 托底色统一由 filled variant 的 token 提供，
 * 宿主元素上写 background 会盖掉 m3e-card 内部的容器取色。
 */
.list-grid .cell {
  /*
   * 必须与 JS 里虚拟滚动的行高常量一致（96px）：
   * 那里的 totalH / 可视区切片 / cellStyle 的 top 都按 96 计算，
   * 这里写 80 会让卡片之间露出 16px 空隙，且滚动越远错位越大。
   */
  height: 96px;
}
.list-grid .thumb {
  width: 96px;
  height: 96px;
  flex-shrink: 0;
  /*
   * 横向布局时 m3e-card 会给 header 里的 img/video 加 aspect-ratio，
   * 纯封面块必须显式锁死尺寸，否则 96px 的方块会被拉成 16/9。
   */
  aspect-ratio: auto;
}
/*
 * 高度必须绑定在视口量级，不能等于整卷 totalH。
 * will-change 会把本元素提升为独立合成层，而合成层的光栅/显存按元素尺寸分配；
 * 整卷高度（上万条媒体时可达数万像素）会让每帧的光栅化范围失控，滚动与点击都会抖。
 * 限制成 100vh 后，层范围只比视口多出上下各 OVERSCAN 行——子元素绝对定位且
 * overflow 可见，不会被裁掉。
 */
.layer {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 100vh;
  will-change: transform;
  transition: opacity 140ms ease;
}
/* 后台重查（搜索/排序）时的轻量反馈：保留旧数据只轻微压暗，不闪骨架屏。
   注意压暗放在 .layer（已限定 100vh）上，不要放在 .virtual-root（整卷高），
   否则 opacity 会把整卷元素变成渲染表面，等于把上面修掉的问题再引回来。 */
.layer.is-refreshing {
  opacity: 0.55;
}

.skeleton-grid {
  display: grid;
  gap: var(--lm-layout-grid-row-gap) var(--lm-layout-grid-column-gap);
}
/* 骨架屏卡片：圆角对齐 m3e-card */
.skeleton-cell {
  border-radius: var(--lm-shape-card);
  overflow: hidden;
  background: var(--lm-card-surface);
}
/*
 * 文字区：放在 m3e-card 的 content 槽里（该槽的 padding 已被 --m3e-card-padding: 0
 * 清零，由这里自己给内边距，封面才能满铺）。
 */
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
.subtitle {
  margin-top: var(--lm-space-2);
  font-size: var(--md-sys-typescale-body-small-size);
  color: var(--md-sys-color-on-surface-variant);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
/* 骨架屏的文字区占位：与真实卡片的 .meta 同高，避免加载完成时跳版 */
.skeleton-cell .meta-skeleton {
  height: 62px;
  padding: var(--lm-space-8) var(--lm-space-12) var(--lm-space-12);
}
.meta-skeleton .line {
  height: 12px;
  border-radius: var(--md-sys-shape-corner-small);
}
.meta-skeleton .line.short {
  width: 55%;
  margin-top: var(--lm-space-4);
}

/*
 * 卡片本体是 m3e-card（自定义元素）。宿主元素默认 display:block，
 * 内部 .base 负责 flex 布局与状态层，因此这里不再自己写 flex 方向。
 * 取色与留白通过组件 token 注入，不改它的状态逻辑（见 MediaCardShell.vue）。
 */
.cell {
  --m3e-card-padding: 0;
  --m3e-card-shape: var(--lm-shape-card);
  --m3e-card-container-color: var(--lm-card-surface);
  --m3e-filled-card-container-color: var(--lm-card-surface);
  --m3e-filled-card-hover-state-layer-color: var(--lm-card-surface-hover);
  --m3e-filled-card-hover-state-layer-opacity: 0.5;
  display: block;
  overflow: hidden;
  border-radius: var(--lm-shape-card);
  /*
   * 上浮反馈保留在卡片本体上（而不是 .thumb）：
   * m3e-card 的 elevation / state-layer 都绘制在自己的 .base 里，
   * 若把 transform 放在内层封面，状态层会留在原处，观感是「封面在托底上滑动」。
   */
  transition: transform var(--lm-motion-card) var(--md-sys-motion-spring-soft);
}
.cell:hover {
  transform: translateY(-4px);
}
.cell:active {
  transform: translateY(-1px);
}
@media (prefers-reduced-motion: reduce) {
  .cell,
  .cell:hover,
  .cell:active {
    transform: none;
    transition: none;
  }
}

.thumb {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  overflow: hidden;
  background: var(--lm-media-placeholder-surface);
  color: var(--lm-media-placeholder-color);
}

.thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.placeholder {
  font-size: 44px;
  color: var(--md-sys-color-outline);
  opacity: 0.7;
  font-variation-settings:
    "FILL" 0,
    "wght" 300;
}

.overlay {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: flex-start;
  justify-content: flex-end;
  padding: 6px;
  opacity: 0;
  background: linear-gradient(to bottom, var(--lm-content-gradient-top) 0%, transparent 40%);
  transition: opacity var(--md-sys-motion-duration-short);
}
.cell:hover .overlay,
.cell:focus-within .overlay {
  opacity: 1;
}
/* 已收藏的项常驻显示心形 */
.overlay.pinned {
  opacity: 1;
  background: none;
}

.fav {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  border: none;
  border-radius: 50%;
  background: var(--lm-content-control-surface);
  color: var(--lm-content-overlay-color);
  cursor: pointer;
  transition:
    transform 140ms var(--md-sys-motion-spring),
    background 160ms var(--md-sys-motion-spring-effects-fast);
}
.fav:hover {
  background: var(--lm-content-control-hover);
  transform: scale(1.1);
}
.fav .material-symbols-outlined {
  font-size: 19px;
}
.fav.on {
  color: var(--lm-content-favorite-color);
}
</style>
