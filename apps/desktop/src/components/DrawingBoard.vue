<script setup lang="ts">
/**
 * 绘画编辑器（LeaferJS）。
 *
 * 画布与图形节点交给 leafer-editor，但**指针交互不依赖 Leafer 的事件系统**：
 * 事件挂在容器上，坐标按画布实际显示尺寸换算成画布坐标。这样「画布比容器大、
 * 按比例缩小显示」时取点依然精确，也不必依赖 Leafer 内部的世界坐标变换。
 *
 * leafer-editor 压缩后约 305 KB，经 await import 动态加载，不进图片页主包。
 *
 * 橡皮 = 用底色绘制。真正的 destination-out 会把底色一起擦成透明，
 * 与「白纸上擦掉」的所见不一致；而 PNG 导出也需要一层不透明底。
 */
import { computed, onBeforeUnmount, onMounted, ref, shallowRef } from "vue";
import { useDrawingStore } from "@/stores/drawing";
import { useSettingsStore } from "@/stores/settings";
import { capabilities } from "@/capabilities";
import { promptText } from "@/composables/useTextPrompt";
import { useFillHeight } from "@/composables/useFillHeight";
import type { DrawTool, Drawing } from "@/features/drawing/types";
import { translate } from "@shared/i18n";

const props = defineProps<{
  /** null 表示新建 */
  drawing: Drawing | null;
  canvasWidth: number;
  canvasHeight: number;
}>();

const emit = defineEmits<{
  (e: "close"): void;
  (e: "saved", d: Drawing): void;
}>();

/** 只取类型（不产生运行时 import）；运行时要等动态 import 回来 */
type LeaferNS = typeof import("leafer-editor");
type LeaferInstance = InstanceType<LeaferNS["Leafer"]>;
type LeafNode = InstanceType<LeaferNS["Path"]>;
type Bounds = { x: number; y: number; width: number; height: number };

const store = useDrawingStore();
const settings = useSettingsStore();

/** 画布底色，同时也是橡皮的颜色 */
const PAPER = "#ffffff";

const rootRef = ref<HTMLElement | null>(null);
const host = ref<HTMLElement | null>(null);
const leafer = shallowRef<LeaferInstance | null>(null);
let ns: LeaferNS | null = null;
/** 已有画作载入的底图：不参与选中、清空，也不进历史 */
let backdrop: LeafNode | null = null;
/** 选中框：仅作视觉反馈，导出前会隐藏 */
let marquee: LeafNode | null = null;

const ready = ref(false);
const failed = ref(false);
const saving = ref(false);
const name = ref(props.drawing?.name ?? store.newDrawingName());
const tool = ref<DrawTool>("brush");
const color = ref("#1b1b1f");
const strokeWidth = ref(6);
const snackOpen = ref(false);
const snackText = ref("");
const canUndo = ref(false);
const canRedo = ref(false);

const { fit: fitHeight } = useFillHeight(rootRef, 520);

const PALETTE = ["#1b1b1f", "#e5484d", "#f5a524", "#30a46c", "#3b82f6", "#8b5cf6"];

const TOOLS: { value: DrawTool; icon: string; key: string }[] = [
  { value: "brush", icon: "brush", key: "draw.brush" },
  { value: "eraser", icon: "ink_eraser", key: "draw.eraser" },
  { value: "line", icon: "horizontal_rule", key: "draw.line" },
  { value: "rect", icon: "crop_square", key: "draw.rect" },
  { value: "ellipse", icon: "circle", key: "draw.ellipse" },
  { value: "text", icon: "title", key: "draw.text" },
  { value: "select", icon: "arrow_selector_tool", key: "draw.select" },
];

function t(key: string) {
  return translate(settings.lang, key);
}

function toast(text: string) {
  snackText.value = text;
  snackOpen.value = false;
  void Promise.resolve().then(() => {
    snackOpen.value = true;
  });
}

// ---- 历史（命令栈）----
interface Cmd {
  undo(): void;
  redo(): void;
}

const undoStack: Cmd[] = [];
const redoStack: Cmd[] = [];

function syncHistory() {
  canUndo.value = undoStack.length > 0;
  canRedo.value = redoStack.length > 0;
}

function pushCmd(c: Cmd) {
  undoStack.push(c);
  redoStack.length = 0;
  syncHistory();
}

function undo() {
  const c = undoStack.pop();
  if (!c) return;
  c.undo();
  redoStack.push(c);
  syncHistory();
}

function redo() {
  const c = redoStack.pop();
  if (!c) return;
  c.redo();
  undoStack.push(c);
  syncHistory();
}

// ---- 节点 ----
/** 可编辑节点：排除底图与选中框 */
function nodes(): LeafNode[] {
  const lf = leafer.value;
  if (!lf) return [];
  const list = ((lf.children ?? []) as unknown as LeafNode[]).slice();
  return list.filter((n) => n !== backdrop && n !== marquee);
}

function commitNode(node: LeafNode) {
  pushCmd({
    undo: () => node.remove(),
    redo: () => leafer.value?.add(node),
  });
}

function boundsOf(node: LeafNode): Bounds | null {
  const b = (node as unknown as { worldBoxBounds?: Bounds }).worldBoxBounds;
  return b && Number.isFinite(b.width) ? b : null;
}

function ensureMarquee(): LeafNode | null {
  if (marquee) return marquee;
  if (!ns || !leafer.value) return null;
  const box = new ns.Rect({
    stroke: "#3b82f6",
    strokeWidth: 2,
    dashPattern: [6, 4],
    hittable: false,
    visible: false,
    // 置顶：否则后画的节点会盖住选中框
    zIndex: 9999,
  });
  leafer.value.add(box);
  marquee = box;
  return box;
}

function showMarquee(node: LeafNode) {
  const box = ensureMarquee();
  const b = boundsOf(node);
  if (!box || !b) return;
  box.set({ x: b.x - 2, y: b.y - 2, width: b.width + 4, height: b.height + 4, visible: true });
}

function hideMarquee() {
  marquee?.set({ visible: false });
}

/** 命中测试：从最上层往下找第一个包住该点的节点 */
function pick(p: { x: number; y: number }): LeafNode | null {
  const list = nodes();
  for (let i = list.length - 1; i >= 0; i--) {
    const b = boundsOf(list[i]);
    if (b && p.x >= b.x && p.x <= b.x + b.width && p.y >= b.y && p.y <= b.y + b.height)
      return list[i];
  }
  return null;
}

// ---- 指针交互 ----
type Gesture =
  | { kind: "free"; node: LeafNode; pts: number[] }
  | { kind: "shape"; node: LeafNode; start: { x: number; y: number }; tool: DrawTool }
  | {
      kind: "move";
      node: LeafNode;
      origin: { x: number; y: number };
      base: { x: number; y: number };
    }
  | null;

let gesture: Gesture = null;

/** 指针位置 → 画布坐标。按 canvas 元素的实际显示尺寸换算，缩放显示也不失真。 */
function toCanvas(e: PointerEvent): { x: number; y: number } {
  const el = (host.value?.querySelector("canvas") ?? host.value) as HTMLElement | null;
  if (!el) return { x: 0, y: 0 };
  const r = el.getBoundingClientRect();
  if (!r.width || !r.height) return { x: 0, y: 0 };
  return {
    x: ((e.clientX - r.left) / r.width) * props.canvasWidth,
    y: ((e.clientY - r.top) / r.height) * props.canvasHeight,
  };
}

async function addText(p: { x: number; y: number }) {
  if (!ns || !leafer.value) return;
  const text = await promptText(t("draw.textPrompt"), "");
  if (!text) return;
  const node = new ns.Text({
    x: p.x,
    y: p.y,
    text,
    fill: color.value,
    fontSize: Math.max(16, strokeWidth.value * 4),
  });
  leafer.value.add(node);
  commitNode(node);
}

function onPointerDown(e: PointerEvent) {
  if (!ready.value || !ns || !leafer.value || e.button !== 0) return;
  const p = toCanvas(e);
  host.value?.setPointerCapture?.(e.pointerId);

  if (tool.value === "text") {
    void addText(p);
    return;
  }

  if (tool.value === "select") {
    const hit = pick(p);
    if (hit) {
      gesture = {
        kind: "move",
        node: hit,
        origin: p,
        base: { x: hit.x ?? 0, y: hit.y ?? 0 },
      };
      showMarquee(hit);
    } else {
      hideMarquee();
    }
    return;
  }

  if (tool.value === "brush" || tool.value === "eraser") {
    const erase = tool.value === "eraser";
    const node = new ns.Path({
      path: "M " + p.x + " " + p.y,
      stroke: erase ? PAPER : color.value,
      strokeWidth: erase ? strokeWidth.value * 2 : strokeWidth.value,
      strokeCap: "round",
      strokeJoin: "round",
    });
    leafer.value.add(node);
    gesture = { kind: "free", node, pts: [p.x, p.y] };
    return;
  }

  const stroke = { stroke: color.value, strokeWidth: strokeWidth.value };
  let node: LeafNode;
  if (tool.value === "rect") {
    node = new ns.Rect({ ...stroke, x: p.x, y: p.y, width: 0, height: 0 });
  } else if (tool.value === "ellipse") {
    node = new ns.Ellipse({ ...stroke, x: p.x, y: p.y, width: 0, height: 0 });
  } else {
    node = new ns.Line({ ...stroke, points: [p.x, p.y, p.x, p.y] });
  }
  leafer.value.add(node);
  gesture = { kind: "shape", node, start: p, tool: tool.value };
}

function onPointerMove(e: PointerEvent) {
  const g = gesture;
  if (!g) return;
  const p = toCanvas(e);

  if (g.kind === "free") {
    const n = g.pts.length;
    const dx = p.x - g.pts[n - 2];
    const dy = p.y - g.pts[n - 1];
    // 抽稀：位移不足 1.5 画布像素就不采点。否则路径串随点数线性增长，
    // 每次 move 都要整串重拼，长笔画会退化成 O(n²)。
    if (dx * dx + dy * dy < 2.25) return;
    g.pts.push(p.x, p.y);
    let d = "M " + g.pts[0] + " " + g.pts[1];
    for (let i = 2; i < g.pts.length; i += 2) {
      d += " L " + g.pts[i] + " " + g.pts[i + 1];
    }
    g.node.set({ path: d });
    return;
  }

  if (g.kind === "shape") {
    const s = g.start;
    if (g.tool === "line") {
      g.node.set({ points: [s.x, s.y, p.x, p.y] });
    } else {
      g.node.set({
        x: Math.min(s.x, p.x),
        y: Math.min(s.y, p.y),
        width: Math.abs(p.x - s.x),
        height: Math.abs(p.y - s.y),
      });
    }
    return;
  }

  g.node.set({
    x: g.base.x + (p.x - g.origin.x),
    y: g.base.y + (p.y - g.origin.y),
  });
  showMarquee(g.node);
}

function onPointerUp(e: PointerEvent) {
  const g = gesture;
  gesture = null;
  if (!g) return;
  host.value?.releasePointerCapture?.(e.pointerId);

  if (g.kind === "free") {
    // 只点了一下没拖动：不留下一个看不见的点
    if (g.pts.length < 4) g.node.remove();
    else commitNode(g.node);
    return;
  }

  if (g.kind === "shape") {
    if (g.tool === "line") {
      // points 只有 Line 有，这里存的是联合类型，取的时候窄化一下
      const pts = (g.node as unknown as { points?: number[] }).points ?? [];
      if (pts.length < 4 || (Math.abs(pts[0] - pts[2]) < 2 && Math.abs(pts[1] - pts[3]) < 2)) {
        g.node.remove();
        return;
      }
    } else if ((g.node.width ?? 0) < 2 && (g.node.height ?? 0) < 2) {
      g.node.remove();
      return;
    }
    commitNode(g.node);
    return;
  }

  const node = g.node;
  const to = { x: node.x ?? 0, y: node.y ?? 0 };
  if (to.x === g.base.x && to.y === g.base.y) return;
  const from = { ...g.base };
  pushCmd({
    undo: () => {
      node.set(from);
      showMarquee(node);
    },
    redo: () => {
      node.set(to);
      showMarquee(node);
    },
  });
}

// ---- 画布尺寸自适应 ----
/** 画布可能比容器大：等比缩到容器内显示，内部像素尺寸不变 */
function fitCanvas() {
  const canvas = host.value?.querySelector("canvas") as HTMLCanvasElement | null;
  const box = host.value;
  if (!canvas || !box) return;
  const w = box.clientWidth;
  const h = box.clientHeight;
  if (!w || !h) return;
  const scale = Math.min(w / props.canvasWidth, h / props.canvasHeight, 1);
  canvas.style.width = Math.round(props.canvasWidth * scale) + "px";
  canvas.style.height = Math.round(props.canvasHeight * scale) + "px";
}

// ---- 清空 / 保存 ----
function clearAll() {
  const list = nodes();
  if (!list.length) return;
  list.forEach((n) => n.remove());
  hideMarquee();
  pushCmd({
    undo: () => list.forEach((n) => leafer.value?.add(n)),
    redo: () => list.forEach((n) => n.remove()),
  });
}

/** data:image/png;base64,xxx → 字节流 */
function dataUrlToBytes(url: string): Uint8Array {
  const comma = url.indexOf(",");
  const base64 = comma >= 0 ? url.slice(comma + 1) : url;
  const binary = atob(base64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

async function save() {
  const lf = leafer.value;
  if (!lf || saving.value) return;
  saving.value = true;
  try {
    // 选中框不能进成品图
    hideMarquee();
    // pixelRatio 固定为 1：画布自身就是成品的分辨率，导出尺寸必须等于声明的画布尺寸
    const res = await lf.export("png", { screenshot: true, fill: PAPER, pixelRatio: 1 });
    const data = res?.data;
    if (typeof data !== "string") throw new Error("unexpected export result");
    const targetId = name.value.trim() || store.newDrawingName();
    const saved = await store.save(targetId, dataUrlToBytes(data));
    // 改名保存后清掉旧文件
    if (props.drawing && props.drawing.id !== targetId) {
      await store.remove(props.drawing.id);
    }
    name.value = saved.name;
    emit("saved", saved);
    toast(t("draw.saved"));
  } catch {
    toast(t("draw.saveFailed"));
  } finally {
    saving.value = false;
  }
}

/**
 * 读取 m3e-slider 当前值。
 * 值挂在 m3e-slider-thumb 上，input 事件由 thumb 冒泡到外层 slider，
 * 所以用 e.currentTarget（监听所在的 slider）取 thumb.value（与 SettingsView 同一套处理）。
 */
function onWidthInput(e: Event) {
  const host = e.currentTarget as { thumb?: { value?: number | null } | null } | null;
  const v = host?.thumb?.value;
  if (typeof v === "number" && Number.isFinite(v)) strokeWidth.value = Math.round(v);
}

/** m3e-snackbar 自动关闭后要把 open 同步回来，否则下次 toast 时 open 仍是 true，不会重开 */
function onSnackToggle(e: Event) {
  snackOpen.value = Boolean((e.target as HTMLElement & { open?: boolean }).open);
}

function onKeydown(e: KeyboardEvent) {
  const mod = e.ctrlKey || e.metaKey;
  if (!mod) return;
  const key = e.key.toLowerCase();
  if (key === "z" && !e.shiftKey) {
    e.preventDefault();
    undo();
  } else if ((key === "z" && e.shiftKey) || key === "y") {
    e.preventDefault();
    redo();
  } else if (key === "s") {
    e.preventDefault();
    void save();
  }
}

// ---- 生命周期 ----
let ro: ResizeObserver | null = null;

onMounted(async () => {
  try {
    ns = await import("leafer-editor");
    if (!host.value) return;
    const lf = new ns.Leafer({
      view: host.value,
      width: props.canvasWidth,
      height: props.canvasHeight,
      fill: PAPER,
      // 显示按设备像素比走（高分屏清晰），导出时再压回 1
      pixelRatio: Math.min(window.devicePixelRatio || 1, 2),
    });
    leafer.value = lf;

    if (props.drawing) {
      const bg = new ns.Image({
        x: 0,
        y: 0,
        width: props.canvasWidth,
        height: props.canvasHeight,
        url: capabilities.thumbUrl(props.drawing.path),
        hittable: false,
      });
      lf.add(bg);
      backdrop = bg;
    }

    ready.value = true;
    fitCanvas();
    ro = new ResizeObserver(fitCanvas);
    ro.observe(host.value);
  } catch {
    failed.value = true;
  }
});

onBeforeUnmount(() => {
  ro?.disconnect();
  ro = null;
  leafer.value?.destroy();
  leafer.value = null;
  ns = null;
});

const strokeLabel = computed(() => String(strokeWidth.value));
</script>

<template>
  <div ref="rootRef" class="board" tabindex="-1" @keydown="onKeydown">
    <!-- 顶部：返回 / 命名 / 历史 / 清空 / 保存 -->
    <div class="head">
      <m3e-icon-button size="small" :title="t('draw.back')" @click="emit('close')">
        <span class="material-symbols-outlined">arrow_back</span>
      </m3e-icon-button>
      <input
        v-model="name"
        class="name-input"
        spellcheck="false"
        :placeholder="t('draw.namePlaceholder')"
      />
      <span class="grow"></span>
      <m3e-icon-button size="small" :disabled="!canUndo" :title="t('draw.undo')" @click="undo">
        <span class="material-symbols-outlined">undo</span>
      </m3e-icon-button>
      <m3e-icon-button size="small" :disabled="!canRedo" :title="t('draw.redo')" @click="redo">
        <span class="material-symbols-outlined">redo</span>
      </m3e-icon-button>
      <m3e-icon-button size="small" :title="t('draw.clear')" @click="clearAll">
        <span class="material-symbols-outlined">delete_sweep</span>
      </m3e-icon-button>
      <m3e-button variant="filled" size="small" :disabled="saving || !ready" @click="save">
        <span slot="icon" class="material-symbols-outlined">save</span>
        {{ t("draw.save") }}
      </m3e-button>
    </div>

    <div class="body">
      <!-- 左侧：工具 / 颜色 / 线宽 -->
      <aside class="rail">
        <m3e-toolbar vertical variant="standard" shape="rounded" class="tool-stack">
          <m3e-icon-button
            v-for="tl in TOOLS"
            :key="tl.value"
            size="small"
            class="tool"
            :class="{ on: tool === tl.value }"
            :title="t(tl.key)"
            @click="tool = tl.value"
          >
            <span class="material-symbols-outlined">{{ tl.icon }}</span>
          </m3e-icon-button>
        </m3e-toolbar>

        <div class="swatches">
          <button
            v-for="c in PALETTE"
            :key="c"
            class="swatch"
            :class="{ on: color.toLowerCase() === c }"
            :style="{ background: c }"
            :title="c"
            @click="color = c"
          ></button>
          <input v-model="color" type="color" class="picker" :title="t('draw.color')" />
        </div>

        <div class="width">
          <span class="width-label">{{ t("draw.strokeWidth") }} {{ strokeLabel }}</span>
          <m3e-slider :min="1" :max="48" size="small" @input="onWidthInput">
            <m3e-slider-thumb :value="strokeWidth"></m3e-slider-thumb>
          </m3e-slider>
        </div>
      </aside>

      <!-- 画布 -->
      <div class="stage">
        <div
          ref="host"
          class="canvas-host"
          @pointerdown="onPointerDown"
          @pointermove="onPointerMove"
          @pointerup="onPointerUp"
          @pointercancel="onPointerUp"
        ></div>
        <p v-if="!ready && !failed" class="hint">{{ t("draw.loading") }}</p>
        <p v-if="failed" class="hint error">{{ t("draw.loadFailed") }}</p>
      </div>
    </div>

    <m3e-snackbar :open="snackOpen" :duration="2400" @toggle="onSnackToggle">
      {{ snackText }}
    </m3e-snackbar>
  </div>
</template>

<style scoped>
.board {
  display: flex;
  flex-direction: column;
  gap: 12px;
  /* 兜底高度：脚本量到精确值后会用内联样式覆盖（见 useFillHeight） */
  height: clamp(520px, 72vh, 900px);
  outline: none;
}

.head {
  display: flex;
  align-items: center;
  gap: 8px;
}

.grow {
  flex: 1;
}

.name-input {
  min-width: 0;
  max-width: 320px;
  padding: 7px 12px;
  font-size: 14px;
  font-family: inherit;
  color: var(--md-sys-color-on-surface);
  background: var(--md-sys-color-surface-container-high);
  border: 1px solid transparent;
  border-radius: 999px;
  outline: none;
}

.name-input:focus {
  border-color: var(--md-sys-color-primary);
}

.body {
  flex: 1;
  min-height: 0;
  display: flex;
  gap: 12px;
}

/* ---- 工具轨 ---- */
.rail {
  flex: 0 0 auto;
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 8px;
  border-radius: 18px;
  background: var(--md-sys-color-surface-container-low);
  border: 1px solid var(--md-sys-color-outline-variant);
}

.tool-stack {
  --m3e-toolbar-gap: 2px;
}

/* 当前工具：用次级容器色标出，沿用 m3e 的色板 */
.tool.on {
  background: var(--md-sys-color-secondary-container);
  color: var(--md-sys-color-on-secondary-container);
}

.swatches {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 6px;
}

.swatch {
  width: 24px;
  height: 24px;
  padding: 0;
  border: none;
  border-radius: 999px;
  cursor: pointer;
  box-shadow: inset 0 0 0 1px var(--lm-hairline);
}

.swatch.on {
  outline: 2px solid var(--md-sys-color-primary);
  outline-offset: 2px;
}

.picker {
  width: 24px;
  height: 24px;
  padding: 0;
  border: none;
  border-radius: 999px;
  cursor: pointer;
  background: none;
  box-shadow: inset 0 0 0 1px var(--lm-hairline);
}

.width {
  display: flex;
  flex-direction: column;
  gap: 6px;
  width: 76px;
}

.width-label {
  font-size: 11px;
  color: var(--md-sys-color-on-surface-variant);
  font-variant-numeric: tabular-nums;
}

/* ---- 画布区 ---- */
.stage {
  position: relative;
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  border-radius: 18px;
  background: var(--md-sys-color-surface-container);
  box-shadow: inset 0 0 0 1px var(--lm-hairline);
}

.canvas-host {
  display: flex;
  align-items: center;
  justify-content: center;
  line-height: 0;
  /* 触屏/笔：关掉浏览器手势，否则拖动会被当成滚动 */
  touch-action: none;
  cursor: crosshair;
}

.canvas-host :deep(canvas) {
  border-radius: 6px;
  box-shadow: var(--md-elevation-2);
}

.hint {
  position: absolute;
  font-size: 13px;
  color: var(--md-sys-color-on-surface-variant);
}

.hint.error {
  color: #b3382f;
}
</style>
