<script setup lang="ts">
/**
 * 创作 —— 书籍页里的写作工作台。
 *
 * 定位与参考项目的取舍：
 *   参考项目（花笺）把「分栏编辑器 + 滚动同步 + 工具栏 + 状态栏」放在 MainWindow，
 *   这里沿用它的信息架构（左侧草稿列表 / 顶部标题+模式切换 / 格式工具栏 /
 *   源码与预览双栏 / 底部状态栏），但做了三处简化：
 *     1. 渲染改用 marked + DOMPurify（见 features/writing/markdown.ts），
 *        不引入 unified/remark/rehype 十几个包；
 *     2. 滚动同步只做**按比例的粗同步**（rAF 节流 + 双向锁），
 *        不做参考项目那套「隐藏 mirror div 逐块测量」的重型实现；
 *     3. 不做 KaTeX 数学与 HTML 透传（省体积，也收紧注入面）。
 *
 * 界面一律用 @m3e/web 组件搭建（toolbar / icon-button / button / list /
 * form-field / snackbar / button-group），不手写按钮、列表、输入框等基元。
 */
import { computed, nextTick, onActivated, onBeforeUnmount, onMounted, ref, watch } from "vue";
import MarkdownPreview from "@/components/MarkdownPreview.vue";
import SegmentedTabs from "@/components/SegmentedTabs.vue";
import { useWritingStore } from "@/stores/writing";
import { useSettingsStore } from "@/stores/settings";
import { promptText } from "@/composables/useTextPrompt";
import {
  countLines,
  countWords,
  readingMinutes,
  renderMarkdown,
} from "@/features/writing/markdown";
import type { Draft, WriteMode } from "@/features/writing/types";
import { translate } from "@shared/i18n";

const store = useWritingStore();
const settings = useSettingsStore();

/** 反引号用码点写，避免本文件里出现裸反引号（源码里到处都是 markdown 片段） */
const TICK = "\u0060";
const FENCE = TICK + TICK + TICK;

const mode = ref<WriteMode>("split");
const title = ref("");
const content = ref("");
/** 预览 HTML：与输入解耦，避免每次按键都重渲染整篇 */
const html = ref("");
const editorRef = ref<HTMLTextAreaElement | null>(null);
const snackOpen = ref(false);
const snackText = ref("");

let htmlTimer: ReturnType<typeof setTimeout> | null = null;

function t(key: string) {
  return translate(settings.lang, key);
}

const modeTabs = computed(() => [
  { value: "edit", label: t("write.modeEdit"), icon: "edit_note" },
  { value: "split", label: t("write.modeSplit"), icon: "vertical_split" },
  { value: "preview", label: t("write.modePreview"), icon: "visibility" },
]);

function displayTitle(d: Draft) {
  return d.title?.trim() || t("write.untitled");
}

function formatTime(ts: number) {
  const diff = Date.now() - ts;
  if (diff < 60_000) return t("write.justNow");
  if (diff < 3_600_000) return Math.floor(diff / 60_000) + " " + t("write.minutesAgo");
  if (diff < 86_400_000) return Math.floor(diff / 3_600_000) + " " + t("write.hoursAgo");
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes())
  );
}

// ---- 与仓库同步 ----
function syncFromStore() {
  title.value = store.active?.title ?? "";
  content.value = store.active?.content ?? "";
}

function renderNow() {
  html.value = renderMarkdown(content.value);
}

function scheduleRender() {
  if (htmlTimer) clearTimeout(htmlTimer);
  htmlTimer = setTimeout(renderNow, 150);
}

watch(
  () => store.activeId,
  () => {
    syncFromStore();
    renderNow();
  },
  { immediate: true },
);

watch(title, (v) => {
  if (store.activeId) store.rename(store.activeId, v);
});

watch(content, (v) => {
  if (store.activeId) store.setContent(store.activeId, v);
  scheduleRender();
});

/** 工作台根节点：用来按窗口剩余高度定尺寸 */
const rootRef = ref<HTMLElement | null>(null);
/** 草稿列表是否展开：收起后编辑区吃满整行 */
const sidebarOpen = ref(true);
let sizeObserver: ResizeObserver | null = null;

/**
 * 让工作台吃满窗口剩下的高度。
 *
 * 不去猜「页头 + 分段条 + 内边距」一共多少像素：main-content 的内边距是可换肤的
 * 令牌 --lm-content-pad（0~64px），底部还可能多出一条迷你播放条，写死偏移量迟早错位。
 * 所以直接量：工作台顶边到滚动容器内容区底部的距离。
 *
 * 用「内容坐标」（减掉 scrollTop）而不是视口坐标——否则页面一旦出现滚动，
 * 量出来的值会随滚动变化，形成「越滚越高」的正反馈。
 */
function fitHeight() {
  const el = rootRef.value;
  if (!el) return;
  const scroller = el.closest(".main-content") as HTMLElement | null;
  if (!scroller) {
    el.style.height = "";
    return;
  }
  const cs = getComputedStyle(scroller);
  const padTop = parseFloat(cs.paddingTop) || 0;
  const padBottom = parseFloat(cs.paddingBottom) || 0;
  const offsetInContent =
    el.getBoundingClientRect().top -
    scroller.getBoundingClientRect().top -
    padTop +
    scroller.scrollTop;
  const available = scroller.clientHeight - padTop - padBottom - offsetInContent;
  el.style.height = Math.max(360, Math.round(available)) + "px";
}

onMounted(() => {
  fitHeight();
  window.addEventListener("resize", fitHeight);
  const scroller = rootRef.value?.closest(".main-content");
  if (scroller && typeof ResizeObserver !== "undefined") {
    sizeObserver = new ResizeObserver(fitHeight);
    sizeObserver.observe(scroller);
  }
  void store.load().then(() => {
    syncFromStore();
    renderNow();
    fitHeight();
  });
});

onActivated(() => {
  if (!store.loaded) void store.load();
  void nextTick(fitHeight);
});

onBeforeUnmount(() => {
  if (htmlTimer) clearTimeout(htmlTimer);
  window.removeEventListener("resize", fitHeight);
  sizeObserver?.disconnect();
  sizeObserver = null;
  void store.flush();
});

// ---- 反馈 ----
function toast(text: string) {
  snackText.value = text;
  snackOpen.value = false;
  void nextTick(() => {
    snackOpen.value = true;
  });
}

function onSnackToggle(e: Event) {
  snackOpen.value = Boolean((e.target as HTMLElement & { open?: boolean }).open);
}

// ---- 编辑操作 ----
/**
 * 写入文本。
 * 优先用 execCommand("insertText")：它会走浏览器原生编辑管线，**保留 undo 栈**
 * （直接改 v-model 会让 Ctrl+Z 失效）。不可用时回退到手动拼接。
 */
function insertText(text: string) {
  const ta = editorRef.value;
  if (!ta) return;
  ta.focus();
  let ok = false;
  try {
    ok = document.execCommand("insertText", false, text);
  } catch {
    ok = false;
  }
  if (!ok) {
    const s = ta.selectionStart;
    const e = ta.selectionEnd;
    content.value = content.value.slice(0, s) + text + content.value.slice(e);
    const caret = s + text.length;
    void nextTick(() => ta.setSelectionRange(caret, caret));
  }
}

/** 用前后缀包裹选区（无选区时插入占位文本并选中它） */
function wrap(before: string, after: string, placeholder: string) {
  const ta = editorRef.value;
  if (!ta) return;
  const s = ta.selectionStart;
  const e = ta.selectionEnd;
  const selected = content.value.slice(s, e);
  const inner = selected || placeholder;
  ta.focus();
  ta.setSelectionRange(s, e);
  insertText(before + inner + after);
  const from = s + before.length;
  void nextTick(() => ta.setSelectionRange(from, from + inner.length));
}

/** 给选中的每一行加前缀；若已全部带前缀则视为取消 */
function prefixLines(prefix: string, ordered = false) {
  const ta = editorRef.value;
  if (!ta) return;
  const s = ta.selectionStart;
  const e = ta.selectionEnd;
  const start = content.value.lastIndexOf("\n", Math.max(0, s - 1)) + 1;
  let end = content.value.indexOf("\n", e);
  if (end < 0) end = content.value.length;
  const lines = content.value.slice(start, end).split("\n");
  const all = lines.every((l) => l.trimStart().startsWith(prefix));
  const next = lines
    .map((l, i) => {
      if (all) return l.replace(prefix, "");
      return ordered ? i + 1 + ". " + l : prefix + l;
    })
    .join("\n");
  ta.focus();
  ta.setSelectionRange(start, end);
  insertText(next);
  void nextTick(() => ta.setSelectionRange(start, start + next.length));
}

/** 标题：当前行在 # ~ ##### 之间循环，再按一次取消 */
function heading() {
  const ta = editorRef.value;
  if (!ta) return;
  const s = ta.selectionStart;
  const start = content.value.lastIndexOf("\n", Math.max(0, s - 1)) + 1;
  let end = content.value.indexOf("\n", s);
  if (end < 0) end = content.value.length;
  const line = content.value.slice(start, end);
  const m = /^(#{1,5}) (.*)$/.exec(line);
  const level = m ? m[1].length : 0;
  const body = m ? m[2] : line;
  const next = level >= 5 ? body : "#".repeat(level + 1) + " " + body;
  ta.focus();
  ta.setSelectionRange(start, end);
  insertText(next);
  void nextTick(() => ta.setSelectionRange(start, start + next.length));
}

function codeBlock() {
  wrap(FENCE + "\n", "\n" + FENCE, "代码");
}

function insertTable() {
  wrap("", "", "| 列 1 | 列 2 |\n| --- | --- |\n| 内容 | 内容 |");
}

function insertDivider() {
  wrap("\n\n---\n\n", "", "");
}

const actions = computed(() => [
  { key: "bold", icon: "format_bold", label: "粗体 (Ctrl+B)", run: () => wrap("**", "**", "粗体") },
  {
    key: "italic",
    icon: "format_italic",
    label: "斜体 (Ctrl+I)",
    run: () => wrap("*", "*", "斜体"),
  },
  {
    key: "strike",
    icon: "strikethrough_s",
    label: "删除线",
    run: () => wrap("~~", "~~", "删除线"),
  },
  { key: "heading", icon: "format_h1", label: "标题（1-5 级循环）", run: heading },
  { key: "quote", icon: "format_quote", label: "引用", run: () => prefixLines("> ") },
  { key: "ul", icon: "format_list_bulleted", label: "无序列表", run: () => prefixLines("- ") },
  {
    key: "ol",
    icon: "format_list_numbered",
    label: "有序列表",
    run: () => prefixLines("1. ", true),
  },
  { key: "code", icon: "code", label: "行内代码", run: () => wrap(TICK, TICK, "代码") },
  { key: "fence", icon: "code_blocks", label: "代码块", run: codeBlock },
  { key: "link", icon: "link", label: "链接", run: () => wrap("[", "](https://)", "链接文字") },
  { key: "image", icon: "image", label: "图片", run: () => wrap("![", "](路径)", "图片说明") },
  { key: "table", icon: "table", label: "表格", run: insertTable },
  { key: "divider", icon: "horizontal_rule", label: "分隔线", run: insertDivider },
  { key: "alert", icon: "info", label: "提示块", run: () => wrap("> [!NOTE]\n> ", "", "备注内容") },
]);

function onKeydown(e: KeyboardEvent) {
  const mod = e.ctrlKey || e.metaKey;
  const key = e.key.toLowerCase();
  if (mod && key === "s") {
    e.preventDefault();
    void store.flush().then(() => toast(t("write.saved")));
    return;
  }
  if (mod && key === "b") {
    e.preventDefault();
    wrap("**", "**", "粗体");
    return;
  }
  if (mod && key === "i") {
    e.preventDefault();
    wrap("*", "*", "斜体");
    return;
  }
  if (e.key === "Tab") {
    e.preventDefault();
    insertText("  ");
  }
}

function focusEditor() {
  editorRef.value?.focus();
}

// ---- 草稿操作 ----
async function onNew() {
  store.create();
  await nextTick();
  editorRef.value?.focus();
}

async function onSelect(id: string) {
  await store.select(id);
}

async function onRename(d: Draft) {
  const next = await promptText(t("write.rename"), displayTitle(d));
  if (next) store.rename(d.id, next);
}

/** m3e-dialog 的打开 / 关闭方法 */
interface M3eDialog extends HTMLElement {
  show(): Promise<void>;
  hide(returnValue?: string): Promise<void>;
}

const confirmRef = ref<M3eDialog | null>(null);
const pendingDelete = ref<Draft | null>(null);

/** 删除要的是「是 / 否」，所以用对话框二次确认，而不是文本输入框 */
function onDelete(d: Draft) {
  const el = confirmRef.value;
  if (!el || typeof el.show !== "function") {
    // 组件尚未升级时不留死路：直接删，避免点了没反应
    void store.remove(d.id).then(() => toast(t("write.deleted")));
    return;
  }
  pendingDelete.value = d;
  void el.show();
}

async function confirmDelete() {
  const d = pendingDelete.value;
  pendingDelete.value = null;
  void confirmRef.value?.hide();
  if (!d) return;
  await store.remove(d.id);
  toast(t("write.deleted"));
}

function cancelDelete() {
  pendingDelete.value = null;
  void confirmRef.value?.hide();
}

async function onExport(format: "md" | "html") {
  try {
    const dest = await store.exportActive(format);
    if (dest) toast(t("write.exported"));
  } catch {
    toast(t("write.exportFailed"));
  }
}

async function onCopy() {
  toast((await store.copyActive()) ? t("write.copied") : t("write.exportFailed"));
}

// ---- 滚动同步（按比例粗同步）----
/**
 * 双栏模式下把源码与预览的滚动位置按比例对齐。
 * 用「来源锁 + 双 rAF 释放」避免 A->B->A 的回授抖动（参考项目的做法）。
 */
let syncing: "source" | "preview" | null = null;
const previewRef = ref<HTMLElement | null>(null);

function releaseLock() {
  requestAnimationFrame(() => requestAnimationFrame(() => (syncing = null)));
}

function ratioOf(el: HTMLElement) {
  const max = el.scrollHeight - el.clientHeight;
  return max <= 0 ? 0 : el.scrollTop / max;
}

function onSourceScroll() {
  if (mode.value !== "split" || syncing === "preview") return;
  const ta = editorRef.value;
  const pv = previewRef.value;
  if (!ta || !pv) return;
  syncing = "source";
  const max = pv.scrollHeight - pv.clientHeight;
  pv.scrollTop = ratioOf(ta) * Math.max(0, max);
  releaseLock();
}

function onPreviewScroll() {
  if (mode.value !== "split" || syncing === "source") return;
  const ta = editorRef.value;
  const pv = previewRef.value;
  if (!ta || !pv) return;
  syncing = "preview";
  const max = ta.scrollHeight - ta.clientHeight;
  ta.scrollTop = ratioOf(pv) * Math.max(0, max);
  releaseLock();
}

const saveLabel = computed(() => {
  switch (store.saveState) {
    case "dirty":
      return t("write.dirty");
    case "saving":
      return t("write.saving");
    case "saved":
      return t("write.saved");
    case "error":
      return t("write.saveError");
    default:
      return "";
  }
});
</script>

<template>
  <div ref="rootRef" class="studio">
    <!-- 左：草稿列表（可收起，把整行让给编辑区） -->
    <aside v-show="sidebarOpen" class="drafts">
      <div class="drafts-head">
        <span class="drafts-title">{{ t("write.drafts") }}</span>
        <m3e-icon-button size="small" :title="t('write.newDraft')" @click="onNew">
          <span class="material-symbols-outlined">add</span>
        </m3e-icon-button>
      </div>
      <m3e-list class="draft-list">
        <m3e-list-item
          v-for="d in store.ordered"
          :key="d.id"
          class="draft-item"
          :class="{ active: d.id === store.activeId }"
          @click="onSelect(d.id)"
        >
          <span slot="leading" class="material-symbols-outlined">draft</span>
          <span class="draft-name">{{ displayTitle(d) }}</span>
          <span slot="supporting-text">
            {{ formatTime(d.updatedAt) }} · {{ countWords(d.content) }} {{ t("write.words") }}
          </span>
          <span slot="trailing" class="draft-actions">
            <m3e-icon-button size="small" :title="t('write.rename')" @click.stop="onRename(d)">
              <span class="material-symbols-outlined">edit</span>
            </m3e-icon-button>
            <m3e-icon-button size="small" :title="t('write.deleteDraft')" @click.stop="onDelete(d)">
              <span class="material-symbols-outlined">delete</span>
            </m3e-icon-button>
          </span>
        </m3e-list-item>
      </m3e-list>
    </aside>

    <!-- 右：编辑区 -->
    <section class="editor">
      <div class="doc-head">
        <m3e-icon-button
          size="small"
          :title="sidebarOpen ? t('write.collapseDrafts') : t('write.expandDrafts')"
          @click="sidebarOpen = !sidebarOpen"
        >
          <span class="material-symbols-outlined">{{ sidebarOpen ? "menu_open" : "menu" }}</span>
        </m3e-icon-button>
        <m3e-form-field variant="filled" class="title-field">
          <label slot="label" for="ws-title">{{ t("write.titlePlaceholder") }}</label>
          <input
            id="ws-title"
            v-model="title"
            spellcheck="false"
            @keydown.enter.prevent="focusEditor"
          />
        </m3e-form-field>
        <SegmentedTabs v-model="mode" :tabs="modeTabs" />
      </div>

      <m3e-toolbar class="format-bar" variant="standard" shape="rounded">
        <m3e-icon-button
          v-for="a in actions"
          :key="a.key"
          size="small"
          :title="a.label"
          @click="a.run()"
        >
          <span class="material-symbols-outlined">{{ a.icon }}</span>
        </m3e-icon-button>
      </m3e-toolbar>

      <div class="panes" :class="'mode-' + mode">
        <textarea
          v-show="mode !== 'preview'"
          ref="editorRef"
          v-model="content"
          class="source"
          spellcheck="false"
          :placeholder="t('write.sourcePlaceholder')"
          @keydown="onKeydown"
          @scroll="onSourceScroll"
        ></textarea>
        <div
          v-show="mode !== 'edit'"
          ref="previewRef"
          class="preview-wrap"
          @scroll="onPreviewScroll"
        >
          <MarkdownPreview :html="html" :empty-hint="t('write.emptyHint')" />
        </div>
      </div>

      <footer class="statusbar">
        <span class="stat">{{ countWords(content) }} {{ t("write.words") }}</span>
        <span class="stat">{{ countLines(content) }} {{ t("write.lines") }}</span>
        <span class="stat">{{ readingMinutes(content) }} {{ t("write.minutes") }}</span>
        <span v-if="saveLabel" class="save" :class="store.saveState">{{ saveLabel }}</span>
        <span class="grow"></span>
        <m3e-button size="small" @click="onCopy">
          <span slot="icon" class="material-symbols-outlined">content_copy</span>
          {{ t("write.copy") }}
        </m3e-button>
        <m3e-button size="small" @click="onExport('md')">
          <span slot="icon" class="material-symbols-outlined">download</span>
          Markdown
        </m3e-button>
        <m3e-button size="small" @click="onExport('html')">
          <span slot="icon" class="material-symbols-outlined">html</span>
          HTML
        </m3e-button>
      </footer>
    </section>

    <m3e-snackbar :open="snackOpen" :duration="2400" @toggle="onSnackToggle">
      {{ snackText }}
    </m3e-snackbar>

    <!-- 删除确认 -->
    <m3e-dialog ref="confirmRef" class="confirm-dialog">
      <span slot="header">{{ t("write.deleteDraft") }}</span>
      <p class="confirm-text">{{ t("write.deleteConfirm") }}</p>
      <div slot="actions" end>
        <m3e-button variant="text" size="small" @click="cancelDelete">
          {{ t("actions.cancel") }}
        </m3e-button>
        <m3e-button variant="tonal" size="small" @click="confirmDelete">
          {{ t("actions.delete") }}
        </m3e-button>
      </div>
    </m3e-dialog>
  </div>
</template>

<style scoped>
.studio {
  display: flex;
  gap: 14px;
  /* 兜底高度：脚本量到精确值后会用内联样式覆盖（见 fitHeight） */
  height: clamp(480px, 68vh, 880px);
}

.confirm-dialog {
  --m3e-dialog-min-width: 360px;
}

.confirm-text {
  margin: 0;
  color: var(--md-sys-color-on-surface-variant);
}

/* ---- 草稿列表 ---- */
.drafts {
  flex: 0 0 208px;
  width: 208px;
  display: flex;
  flex-direction: column;
  min-height: 0;
  border: 1px solid var(--md-sys-color-outline-variant);
  border-radius: 16px;
  overflow: hidden;
  background: var(--md-sys-color-surface-container-low);
}

.drafts-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 6px 6px 16px;
  border-bottom: 1px solid var(--md-sys-color-outline-variant);
}

.drafts-title {
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 0.04em;
  color: var(--md-sys-color-on-surface-variant);
}

.draft-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}

.draft-item {
  cursor: pointer;
}

/* 选中态：用色板里的次级容器色，不手写一套新的视觉语言 */
.draft-item.active {
  background: var(--md-sys-color-secondary-container);
  color: var(--md-sys-color-on-secondary-container);
}

.draft-name {
  display: block;
  max-width: 108px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.draft-actions {
  display: flex;
  gap: 2px;
  opacity: 0;
  transition: opacity 0.15s ease;
}

.draft-item:hover .draft-actions,
.draft-item.active .draft-actions {
  opacity: 1;
}

/* ---- 编辑区 ---- */
.editor {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  min-height: 0;
  gap: 8px;
}

.doc-head {
  display: flex;
  align-items: center;
  gap: 12px;
}

.title-field {
  flex: 1;
  min-width: 0;
}

/* 工具栏固定单行：换行会白吃掉一整行高度，宁可横向滚动 */
.format-bar {
  flex-wrap: nowrap;
  overflow-x: auto;
  border-radius: 14px;
  scrollbar-width: none;
}

.format-bar::-webkit-scrollbar {
  display: none;
}

.panes {
  flex: 1;
  min-height: 0;
  display: grid;
  gap: 10px;
}

.panes.mode-split {
  grid-template-columns: 1fr 1fr;
}

.panes.mode-edit,
.panes.mode-preview {
  grid-template-columns: 1fr;
}

.source {
  width: 100%;
  height: 100%;
  min-height: 0;
  padding: 12px 16px;
  font-family: ui-monospace, Consolas, "Cascadia Mono", monospace;
  font-size: 14px;
  line-height: 1.8;
  color: var(--md-sys-color-on-surface);
  background: var(--md-sys-color-surface-container-low);
  border: 1px solid var(--md-sys-color-outline-variant);
  border-radius: 16px;
  resize: none;
  outline: none;
  tab-size: 2;
}

.source:focus {
  border-color: var(--md-sys-color-primary);
}

.source::placeholder {
  color: var(--md-sys-color-on-surface-variant);
  opacity: 0.6;
}

.preview-wrap {
  height: 100%;
  min-height: 0;
  overflow-y: auto;
  padding-top: 4px;
  background: var(--md-sys-color-surface-container-low);
  border: 1px solid var(--md-sys-color-outline-variant);
  border-radius: 16px;
}

/* ---- 状态栏 ---- */
.statusbar {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 0 2px;
  font-size: 12px;
  color: var(--md-sys-color-on-surface-variant);
}

.stat {
  font-variant-numeric: tabular-nums;
}

.grow {
  flex: 1;
}

/* 保存状态用语义色：未保存琥珀 / 失败红 / 已保存绿 */
.save {
  padding: 2px 8px;
  border-radius: 999px;
  background: var(--md-sys-color-surface-container-high);
}

.save.dirty {
  color: #8a6415;
}

.save.error {
  color: #b3382f;
}

.save.saved {
  color: #2f7d3d;
}

/* 窄屏下草稿列表收窄，优先保证编辑区 */
@media (max-width: 1100px) {
  .drafts {
    flex-basis: 190px;
    width: 190px;
  }

  .draft-name {
    max-width: 96px;
  }
}
</style>
