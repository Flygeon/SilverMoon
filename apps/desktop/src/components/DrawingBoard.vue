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
import type { DrawTool, Drawing, ShapeFillMode } from "@/features/drawing/types";
import { SHAPE_FILL_MODES } from "@/features/drawing/types";
import { floodFill } from "@/features/drawing/floodFill";
import { attachGpuCanvas, gpuCanvasAvailable, type GpuCanvasHandle } from "@/utils/gpuCanvas";
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
/** 形状的填充方式（只对 rect / ellipse 生效） */
const fillMode = ref<ShapeFillMode>("stroke");
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
  { value: "fill", icon: "format_color_fill", key: "draw.fill" },
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

/**
 * 撤销/重做后清掉选中态。
 *
 * 历史操作可能移除（或重建）被选中的那个节点，而 `selected` 还指着旧引用 ——
 * 此时按 Del 会去操作一个不在画布上的对象，表现为「按了没反应」或删错东西。
 * 与其在各处判断引用是否还活着，不如统一在历史变动后清空。
 */
function undo() {
  const c = undoStack.pop();
  if (!c) return;
  c.undo();
  redoStack.push(c);
  selected.value = null;
  hideMarquee();
  syncHistory();
}

function redo() {
  const c = redoStack.pop();
  if (!c) return;
  c.redo();
  undoStack.push(c);
  selected.value = null;
  hideMarquee();
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

/**
 * 当前选中的节点（选择工具点出来的）。
 *
 * 单独记一份而不是每次从选中框反推：删除/复制都需要「选中了谁」这个信息，
 * 而选中框只是个视觉节点，反推既绕又容易在撤销后失配。
 */
const selected = shallowRef<LeafNode | null>(null);

/**
 * 内部剪贴板。
 *
 * 为什么不用系统剪贴板：Leafer 的节点不是标准格式，写进系统剪贴板后
 * 无法粘回（其它应用也不认）。应用内复制/粘贴用内存里的一份足矣。
 */
let clipboardNode: LeafNode | null = null;

/**
 * 视图缩放（1 = 适应窗口）。仅影响显示，不影响导出像素。
 *
 * 为什么要有它：画布可能是 1600×900，在窗口里被等比缩小显示，
 * 画细节时**根本看不清落笔位置**。这是「能画」与「画得准」的分界。
 */
const zoom = ref(1);
/** 视图平移（画布像素） */
const pan = ref({ x: 0, y: 0 });

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

/**
 * 十六进制颜色 → RGBA 分量。
 *
 * 只接受 `#rrggbb`（画布取色器与调色板都只产出这一种形式），
 * 解析不了时返回不透明黑，避免调用方拿到 undefined 分量去写像素。
 */
function hexToRgba(hex: string): { r: number; g: number; b: number; a: number } {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return { r: 0, g: 0, b: 0, a: 255 };
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 255 };
}

/**
 * 油漆桶：在点击处做洪水填充。
 *
 * ## 为什么要先把画布「拍平」再填
 *
 * 画布上的内容是 Leafer 的**一堆矢量节点**（路径 / 矩形 / 文字…），
 * 洪水填充需要的是**像素**。因此这里先把当前画布导出成一张位图
 * （`lf.export` 拿到的就是合成后的像素），在像素上填，再把结果作为
 * 一个 Image 节点盖回画布。
 *
 * 代价：填充会把此前的矢量内容**烘焙进这一张位图**（之后不能再单独选中
 * 之前的图形）。这是「单层画布 + 像素级填充」的固有取舍；真正的解法是图层，
 * 那是后续独立的一步。
 *
 * ## 为什么要把原有节点藏起来
 *
 * 填完之后如果不藏，位图会盖在原有矢量上——视觉上对，但再点一次填充时
 * 又会把位图连同矢量一起导出，层层叠叠导致「填充越来越暗」。
 * 因此填充后把之前的节点设为不可见，只留这一张位图作为当前画面。
 * 撤销时反向恢复。
 */
async function applyFill(p: { x: number; y: number }) {
  const lf = leafer.value;
  if (!lf || !ns) return;

  const x = Math.round(p.x);
  const y = Math.round(p.y);
  if (x < 0 || y < 0 || x >= props.canvasWidth || y >= props.canvasHeight) return;

  // 1) 把当前画面导出为像素（选中框与底图不参与，见 export 的 screenshot 语义）
  const hideMarquee = marquee ? (marquee as unknown as { visible: boolean }).visible : false;
  if (marquee) (marquee as unknown as { visible: boolean }).visible = false;
  let pixels: Uint8ClampedArray;
  let width = props.canvasWidth;
  let height = props.canvasHeight;
  try {
    const res = await lf.export("canvas", { screenshot: true, fill: PAPER, pixelRatio: 1 });
    const el = res as unknown as HTMLCanvasElement;
    const ctx = el.getContext("2d");
    if (!ctx) return;
    const img = ctx.getImageData(0, 0, el.width, el.height);
    pixels = img.data;
    width = el.width;
    height = el.height;
  } catch {
    toast(t("draw.fillFailed"));
    return;
  } finally {
    if (marquee && hideMarquee) (marquee as unknown as { visible: boolean }).visible = true;
  }

  // 2) 在像素上填充（纯算法，见 features/drawing/floodFill.ts）
  // 导出的像素尺寸可能与画布逻辑尺寸不同（取决于 Leafer 的 pixelRatio），
  // 因此把点击坐标按比例映射过去。
  const sx = Math.round((x / props.canvasWidth) * width);
  const sy = Math.round((y / props.canvasHeight) * height);
  const changed = floodFill(pixels, width, height, sx, sy, hexToRgba(color.value));
  // 没有改动就不该产生一步历史（例如点在已经是该色的区域上）
  if (changed === 0) return;

  // 3) 填好的像素 → dataURL → Image 节点
  const out = document.createElement("canvas");
  out.width = width;
  out.height = height;
  const octx = out.getContext("2d");
  if (!octx) return;
  // 用 putImageData(ImageData) 时 TS 要求底层 buffer 是 **ArrayBuffer**，
  // 而 Uint8ClampedArray 的 buffer 类型是 ArrayBufferLike（可能是 SharedArrayBuffer）。
  // 这里显式复制到一块新的 Uint8ClampedArray，既满足类型，也避免把
  // getImageData 返回的那块内存继续持有（它可能很大）。
  octx.putImageData(new ImageData(new Uint8ClampedArray(pixels), width, height), 0, 0);

  const image = new ns.Image({
    x: 0,
    y: 0,
    width: props.canvasWidth,
    height: props.canvasHeight,
    url: out.toDataURL("image/png"),
  });
  lf.add(image);

  // 4) 把之前的可见节点藏起来（连同底图），只留这一张位图
  const hidden: LeafNode[] = [];
  for (const n of nodes()) {
    if (n === image) continue;
    if ((n as unknown as { visible?: boolean }).visible !== false) {
      hidden.push(n);
      n.set({ visible: false });
    }
  }
  if (backdrop && (backdrop as unknown as { visible?: boolean }).visible !== false) {
    hidden.push(backdrop);
    backdrop.set({ visible: false });
  }

  // 5) 一步撤销：移除位图 + 恢复被藏起来的节点
  pushCmd({
    undo: () => {
      image.remove();
      for (const n of hidden) n.set({ visible: true });
    },
    redo: () => {
      leafer.value?.add(image);
      for (const n of hidden) n.set({ visible: false });
    },
  });
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
  if (!ready.value || !ns || !leafer.value) return;
  // 中键 / 空格：平移视图（绘画软件的通用习惯），与画布内容无关
  if (e.button === 1 || spaceDown.value) {
    e.preventDefault();
    panStart = { x: e.clientX, y: e.clientY, panX: pan.value.x, panY: pan.value.y };
    host.value?.setPointerCapture?.(e.pointerId);
    return;
  }
  if (e.button !== 0) return;
  const p = toCanvas(e);
  host.value?.setPointerCapture?.(e.pointerId);

  if (tool.value === "text") {
    void addText(p);
    return;
  }

  if (tool.value === "fill") {
    void applyFill(p);
    return;
  }

  if (tool.value === "select") {
    const hit = pick(p);
    if (hit) {
      selected.value = hit;
      gesture = {
        kind: "move",
        node: hit,
        origin: p,
        base: { x: hit.x ?? 0, y: hit.y ?? 0 },
      };
      showMarquee(hit);
    } else {
      selected.value = null;
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

  // 形状的描边 / 填充由 fillMode 决定（直线没有「填充」概念，始终只描边）。
  //
  // 为什么 fill 模式下要把 strokeWidth 置 0 而不是只删 stroke：
  // Leafer 里留着 stroke 会沿路径再描一圈，实心块边缘会比预期粗一圈。
  const mode = fillMode.value;
  const wantStroke = tool.value === "line" || mode === "stroke" || mode === "both";
  const wantFill = tool.value !== "line" && (mode === "fill" || mode === "both");
  const paint: Record<string, unknown> = {
    stroke: wantStroke ? color.value : undefined,
    strokeWidth: wantStroke ? strokeWidth.value : 0,
    fill: wantFill ? color.value : undefined,
  };
  let node: LeafNode;
  if (tool.value === "rect") {
    node = new ns.Rect({ ...paint, x: p.x, y: p.y, width: 0, height: 0 });
  } else if (tool.value === "ellipse") {
    node = new ns.Ellipse({ ...paint, x: p.x, y: p.y, width: 0, height: 0 });
  } else {
    node = new ns.Line({ ...paint, points: [p.x, p.y, p.x, p.y] });
  }
  leafer.value.add(node);
  gesture = { kind: "shape", node, start: p, tool: tool.value };
}

function onPointerMove(e: PointerEvent) {
  // 平移中：优先处理，不走任何绘制分支
  if (panStart) {
    pan.value = {
      x: panStart.panX + (e.clientX - panStart.x),
      y: panStart.panY + (e.clientY - panStart.y),
    };
    applyView();
    return;
  }
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
  if (panStart) {
    panStart = null;
    host.value?.releasePointerCapture?.(e.pointerId);
    return;
  }
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

// ---- 视图：适应窗口 + 缩放 + 平移 ----
/**
 * 「适应窗口」的基准比例。
 *
 * 画布可能比容器大（1600×900 塞进小窗口），此时缩小显示；比容器小则保持 1:1
 * —— 放大到填满只会让像素糊掉，没有意义。
 */
function fitScale(): number {
  const box = host.value;
  if (!box) return 1;
  const w = box.clientWidth;
  const h = box.clientHeight;
  if (!w || !h) return 1;
  return Math.min(w / props.canvasWidth, h / props.canvasHeight, 1);
}

/**
 * 把 zoom / pan 应用到画布元素的显示尺寸上。
 *
 * 只改 **CSS 尺寸与 transform**，不动 Leafer 的内部像素尺寸 —— 因此导出仍是
 * 原始分辨率，缩放纯粹是「看」的事，高分屏清晰度也不受影响。
 */
function applyView() {
  const canvas = host.value?.querySelector("canvas") as HTMLCanvasElement | null;
  const box = host.value;
  if (!canvas || !box) return;
  const scale = fitScale() * zoom.value;
  canvas.style.width = Math.round(props.canvasWidth * scale) + "px";
  canvas.style.height = Math.round(props.canvasHeight * scale) + "px";
  // 平移用 transform 而不是改 left/top：不触发布局重算，拖起来更顺
  canvas.style.transform = "translate(" + pan.value.x + "px, " + pan.value.y + "px)";
  canvas.style.transformOrigin = "center center";
}

/** 滚轮缩放。以光标为锚点的做法留给后续（先做整体缩放，够用且不易错）。 */
function onWheel(e: WheelEvent) {
  e.preventDefault();
  const step = e.deltaY < 0 ? 1.1 : 1 / 1.1;
  zoom.value = Math.min(8, Math.max(0.1, Math.round(zoom.value * step * 100) / 100));
  applyView();
}

/** 空格键按住时进入平移模式（绘画软件的通用习惯）。 */
const spaceDown = ref(false);

function onKeyDownSpace(e: KeyboardEvent) {
  if (e.code !== "Space" || spaceDown.value) return;
  const target = e.target as HTMLElement | null;
  const typing =
    !!target &&
    (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
  if (typing) return;
  // 阻止默认：否则按住空格会滚动容器，画布跟着乱跑
  e.preventDefault();
  spaceDown.value = true;
}

function onKeyUpSpace(e: KeyboardEvent) {
  if (e.code === "Space") spaceDown.value = false;
}

/** 平移手势的起点（屏幕坐标 + 当时的 pan）。 */
let panStart: { x: number; y: number; panX: number; panY: number } | null = null;

function fitCanvas() {
  applyView();
}

// ---- 清空 / 保存 ----
function clearAll() {
  const list = nodes();
  if (!list.length) return;
  list.forEach((n) => n.remove());
  // 必须清掉选中态：否则清空后按 Del 会去操作一个已经不在画布上的节点
  selected.value = null;
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

// ---- 编辑操作（删除 / 复制 / 粘贴）----

/** 删除当前选中的节点（可撤销）。 */
function deleteSelected() {
  const node = selected.value;
  if (!node) return;
  // 防御：节点可能已被历史操作移除（正常情况下 undo/redo 已清选中态，
  // 这里再兜一层，避免产生一条「什么都没删」的空历史）
  if (!nodes().includes(node)) {
    selected.value = null;
    hideMarquee();
    return;
  }
  node.remove();
  selected.value = null;
  hideMarquee();
  pushCmd({
    undo: () => leafer.value?.add(node),
    redo: () => node.remove(),
  });
}

/**
 * 复制当前选中的节点到内部剪贴板。
 *
 * 只记引用、不做深拷贝：Leafer 的节点可以**同时**只存在于一处，
 * 粘贴时再克隆一份（见 pasteClipboard），这样复制本身零成本。
 */
function copySelected() {
  if (!selected.value) return;
  clipboardNode = selected.value;
  toast(t("draw.copied"));
}

/**
 * 把剪贴板里的节点克隆一份贴到画布（略微偏移，避免与原节点完全重叠）。
 *
 * 克隆而不是复用同一个节点：同一个节点不能同时挂在画布两次。
 * `clone()` 是 Leafer 自带的方法，会复制样式与几何。
 */
function pasteClipboard() {
  const src = clipboardNode;
  const lf = leafer.value;
  if (!src || !lf) return;
  const copy = (src as unknown as { clone?: () => LeafNode }).clone?.();
  if (!copy) return;
  // 偏移 16px：粘贴出来的东西要能被看见（否则与原节点严丝合缝，像是没反应）
  copy.set({ x: (src.x ?? 0) + 16, y: (src.y ?? 0) + 16 });
  lf.add(copy);
  selected.value = copy;
  showMarquee(copy);
  pushCmd({
    undo: () => copy.remove(),
    redo: () => leafer.value?.add(copy),
  });
}

/**
 * 快捷键。
 *
 * 分两类：
 * - **带 Ctrl**：撤销/重做/保存/复制/粘贴/删除（跨平台习惯一致）；
 * - **单键**：切工具（B/E/G/R/O/L/T/V）。这是绘画软件的通用习惯，
 *   缺了它每次换工具都要去点图标，效率差一个量级。
 *
 * 单键只在**没有输入焦点**时生效（否则在命名框里打字会误切工具）。
 */
function onKeydown(e: KeyboardEvent) {
  const target = e.target as HTMLElement | null;
  const typing =
    !!target &&
    (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
  const mod = e.ctrlKey || e.metaKey;
  const key = e.key.toLowerCase();

  if (mod) {
    if (key === "z" && !e.shiftKey) {
      e.preventDefault();
      undo();
    } else if ((key === "z" && e.shiftKey) || key === "y") {
      e.preventDefault();
      redo();
    } else if (key === "s") {
      e.preventDefault();
      void save();
    } else if (key === "c") {
      e.preventDefault();
      copySelected();
    } else if (key === "v") {
      e.preventDefault();
      pasteClipboard();
    } else if (key === "a") {
      // 全选：单层画布下没有「多选」，这里选中最上层节点即可
      e.preventDefault();
      const list = nodes();
      if (list.length) {
        selected.value = list[list.length - 1];
        showMarquee(selected.value);
      }
    }
    return;
  }

  if (typing) return;

  // 单键工具切换
  const byKey: Record<string, DrawTool> = {
    b: "brush",
    e: "eraser",
    g: "fill",
    r: "rect",
    o: "ellipse",
    l: "line",
    t: "text",
    v: "select",
  };
  if (byKey[key]) {
    e.preventDefault();
    tool.value = byKey[key];
    return;
  }

  if (key === "delete" || key === "backspace") {
    e.preventDefault();
    deleteSelected();
    return;
  }

  // 缩放：Ctrl+0 之外的单键 +/-，方便快速看细节
  if (key === "=" || key === "+") {
    e.preventDefault();
    zoom.value = Math.min(8, Math.round((zoom.value + 0.25) * 100) / 100);
    applyView();
  } else if (key === "-") {
    e.preventDefault();
    zoom.value = Math.max(0.1, Math.round((zoom.value - 0.25) * 100) / 100);
    applyView();
  } else if (key === "0") {
    e.preventDefault();
    zoom.value = 1;
    pan.value = { x: 0, y: 0 };
    applyView();
  }
}

// ---- 生命周期 ----
let ro: ResizeObserver | null = null;

/**
 * GPU 画布句柄（见 utils/gpuCanvas.ts）。
 *
 * 现状：**并行验证**。传统 DOM 画布（Leafer）照常工作，同时在同一个位置叠一个
 * wgpu 原生窗口，用来证明「Tauri + wgpu 直绘」这条路在三个平台上成立。
 *
 * 为什么并行而不是直接替换：替换掉整个画布意味着工具、笔刷、撤销全要重写，
 * 而这条路唯一的风险点（原生窗口 + wgpu surface 能否建起来）还没验证过。
 * 先把它验证了，再谈替换 —— 万一某平台不通，现在的功能一点没损失。
 */
let gpuCanvas: GpuCanvasHandle | null = null;

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

    // GPU 画布：在同一个位置叠一个 wgpu 原生窗口（可行性验证，见上方说明）。
    // 浏览器预览下 gpuCanvasAvailable() 为 false，整个分支跳过。
    if (gpuCanvasAvailable() && host.value) {
      gpuCanvas = attachGpuCanvas(host.value);
    }
  } catch {
    failed.value = true;
  }
});

onBeforeUnmount(() => {
  ro?.disconnect();
  ro = null;
  // 先收 GPU 画布：它是独立的原生窗口，不关掉会留在屏幕上
  void gpuCanvas?.dispose();
  gpuCanvas = null;
  leafer.value?.destroy();
  leafer.value = null;
  ns = null;
});

const strokeLabel = computed(() => String(strokeWidth.value));

/** 画布上的图形数量（右侧信息面板显示）。排除底图与选中框。 */
const shapeCount = computed(() => nodes().length);

/** 按倍率缩放（工具栏 +/- 按钮用）。 */
function zoomBy(factor: number) {
  zoom.value = Math.min(8, Math.max(0.1, Math.round(zoom.value * factor * 100) / 100));
  applyView();
}

/** 恢复「适应窗口」。 */
function zoomReset() {
  zoom.value = 1;
  pan.value = { x: 0, y: 0 };
  applyView();
}
</script>

<template>
  <div
    ref="rootRef"
    class="board"
    tabindex="-1"
    @keydown="onKeydown"
    @keydown.space="onKeyDownSpace"
    @keyup.space="onKeyUpSpace"
  >
    <!-- ============ 顶部菜单栏 ============ -->
    <header class="menubar">
      <div class="menu-left">
        <m3e-icon-button size="small" :title="t('draw.back')" @click="emit('close')">
          <span class="material-symbols-outlined">arrow_back</span>
        </m3e-icon-button>
        <span class="app-mark material-symbols-outlined">draw</span>
        <input
          v-model="name"
          class="name-input"
          spellcheck="false"
          :placeholder="t('draw.namePlaceholder')"
        />
      </div>

      <div class="menu-right">
        <m3e-icon-button size="small" :disabled="!canUndo" :title="t('draw.undo')" @click="undo">
          <span class="material-symbols-outlined">undo</span>
        </m3e-icon-button>
        <m3e-icon-button size="small" :disabled="!canRedo" :title="t('draw.redo')" @click="redo">
          <span class="material-symbols-outlined">redo</span>
        </m3e-icon-button>
        <span class="sep"></span>
        <m3e-icon-button size="small" :title="t('draw.clear')" @click="clearAll">
          <span class="material-symbols-outlined">delete_sweep</span>
        </m3e-icon-button>
        <m3e-button variant="filled" size="small" :disabled="saving || !ready" @click="save">
          <span slot="icon" class="material-symbols-outlined">save</span>
          {{ t("draw.save") }}
        </m3e-button>
      </div>
    </header>

    <!-- ============ 工具选项栏（随工具变化） ============ -->
    <div class="optionsbar">
      <span class="opt-label">{{ t("draw.strokeWidth") }}</span>
      <div class="opt-slider">
        <m3e-slider :min="1" :max="48" size="small" @input="onWidthInput">
          <m3e-slider-thumb :value="strokeWidth"></m3e-slider-thumb>
        </m3e-slider>
      </div>
      <span class="opt-value">{{ strokeLabel }}</span>

      <span class="sep"></span>

      <!-- 形状填充方式：只对矩形/椭圆有意义（直线没有填充概念） -->
      <template v-if="tool === 'rect' || tool === 'ellipse'">
        <span class="opt-label">{{ t("draw.fillMode") }}</span>
        <m3e-toolbar variant="standard" shape="rounded">
          <m3e-icon-button
            v-for="fm in SHAPE_FILL_MODES"
            :key="fm.value"
            size="small"
            :class="{ on: fillMode === fm.value }"
            :title="t(fm.key)"
            @click="fillMode = fm.value"
          >
            <span class="material-symbols-outlined">{{ fm.icon }}</span>
          </m3e-icon-button>
        </m3e-toolbar>
      </template>

      <span class="grow"></span>

      <!-- 缩放控件 -->
      <m3e-icon-button size="small" :title="t('draw.zoomOut')" @click="zoomBy(1 / 1.25)">
        <span class="material-symbols-outlined">remove</span>
      </m3e-icon-button>
      <span class="zoom-value">{{ Math.round(zoom * 100) }}%</span>
      <m3e-icon-button size="small" :title="t('draw.zoomIn')" @click="zoomBy(1.25)">
        <span class="material-symbols-outlined">add</span>
      </m3e-icon-button>
      <m3e-button variant="text" size="small" :title="t('draw.zoomReset')" @click="zoomReset">
        {{ t("draw.zoomFit") }}
      </m3e-button>
    </div>

    <div class="body">
      <!-- ============ 左侧工具轨 ============ -->
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
      </aside>

      <!-- ============ 画布区 ============ -->
      <main class="stage" :class="{ panning: spaceDown }">
        <div class="canvas-scroll">
          <div
            ref="host"
            class="canvas-host"
            @pointerdown="onPointerDown"
            @pointermove="onPointerMove"
            @pointerup="onPointerUp"
            @pointercancel="onPointerUp"
            @wheel="onWheel"
          ></div>
        </div>
        <p v-if="!ready && !failed" class="hint">{{ t("draw.loading") }}</p>
        <p v-if="failed" class="hint error">{{ t("draw.loadFailed") }}</p>
      </main>

      <!-- ============ 右侧属性面板 ============ -->
      <aside class="panel">
        <section class="panel-block">
          <h3 class="panel-title">{{ t("draw.color") }}</h3>
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
          </div>
          <label class="picker-row">
            <input v-model="color" type="color" class="picker" />
            <span class="picker-text">{{ color.toUpperCase() }}</span>
          </label>
        </section>

        <section class="panel-block">
          <h3 class="panel-title">{{ t("draw.canvasInfo") }}</h3>
          <div class="info-row">
            <span>{{ t("draw.size") }}</span>
            <span class="info-value">{{ canvasWidth }} × {{ canvasHeight }}</span>
          </div>
          <div class="info-row">
            <span>{{ t("draw.shapes") }}</span>
            <span class="info-value">{{ shapeCount }}</span>
          </div>
        </section>

        <section class="panel-block hints">
          <h3 class="panel-title">{{ t("draw.shortcuts") }}</h3>
          <div class="hint-row">
            <kbd>B</kbd><kbd>E</kbd><kbd>G</kbd><span>{{ t("draw.toolKeys") }}</span>
          </div>
          <div class="hint-row">
            <kbd>Space</kbd><span>{{ t("draw.panKey") }}</span>
          </div>
          <div class="hint-row">
            <kbd>Del</kbd><span>{{ t("draw.deleteKey") }}</span>
          </div>
          <div class="hint-row">
            <kbd>Ctrl</kbd><kbd>Z</kbd><span>{{ t("draw.undoKey") }}</span>
          </div>
          <div class="hint-row">
            <kbd>Ctrl</kbd><kbd>C</kbd><kbd>V</kbd><span>{{ t("draw.copyKey") }}</span>
          </div>
        </section>
      </aside>
    </div>

    <m3e-snackbar :open="snackOpen" :duration="2400" @toggle="onSnackToggle">
      {{ snackText }}
    </m3e-snackbar>
  </div>
</template>

<style scoped>
/*
 * 专业绘画布局：菜单栏 / 选项栏 / 工具轨 / 画布 / 属性面板。
 *
 * 高度用 100% 而不是固定值：本组件现在跑在**独立最大化窗口**里
 * （views/DrawingWindow.vue），窗口本身就是舞台，不需要再自己算高度。
 * 原先那个 clamp(520px, 72vh, 900px) 是为嵌在主窗口里写的，已不需要。
 */
.board {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  min-height: 0;
  overflow: hidden;
  background: var(--md-sys-color-surface-container-lowest);
  outline: none;
}

/* ---- 顶部菜单栏 ---- */
.menubar {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 12px;
  background: var(--md-sys-color-surface-container-low);
  border-bottom: 1px solid var(--md-sys-color-outline-variant);
}

.menu-left,
.menu-right {
  display: flex;
  align-items: center;
  gap: 6px;
}

.app-mark {
  margin: 0 4px 0 8px;
  color: var(--md-sys-color-primary);
}

.name-input {
  min-width: 0;
  max-width: 320px;
  padding: 6px 14px;
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

/* 竖向分隔线 */
.sep {
  width: 1px;
  height: 20px;
  margin: 0 6px;
  background: var(--md-sys-color-outline-variant);
}

.grow {
  flex: 1;
}

/* ---- 工具选项栏 ---- */
.optionsbar {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 14px;
  background: var(--md-sys-color-surface-container);
  border-bottom: 1px solid var(--md-sys-color-outline-variant);
}

.opt-label {
  font-size: 12px;
  color: var(--md-sys-color-on-surface-variant);
}

.opt-value {
  min-width: 26px;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  color: var(--md-sys-color-on-surface);
}

.opt-slider {
  width: 140px;
}

.zoom-value {
  min-width: 46px;
  text-align: center;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  color: var(--md-sys-color-on-surface-variant);
}

/* ---- 主体三栏 ---- */
.body {
  flex: 1;
  min-height: 0;
  display: flex;
}

/* 工具轨：竖排图标，贴左边缘 */
.rail {
  flex: 0 0 auto;
  padding: 10px 8px;
  background: var(--md-sys-color-surface-container-low);
  border-right: 1px solid var(--md-sys-color-outline-variant);
}

.tool-stack {
  --m3e-toolbar-gap: 4px;
}

/* 当前工具：用次级容器色标出，沿用 m3e 的色板 */
.tool.on {
  background: var(--md-sys-color-secondary-container);
  color: var(--md-sys-color-on-secondary-container);
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
  /* 棋盘格底：让白色画布与容器区分开（画布是白的，容器是浅灰） */
  background-color: var(--md-sys-color-surface-container-lowest);
  background-image:
    linear-gradient(45deg, var(--md-sys-color-surface-container) 25%, transparent 25%),
    linear-gradient(-45deg, var(--md-sys-color-surface-container) 25%, transparent 25%),
    linear-gradient(45deg, transparent 75%, var(--md-sys-color-surface-container) 75%),
    linear-gradient(-45deg, transparent 75%, var(--md-sys-color-surface-container) 75%);
  background-size: 20px 20px;
  background-position:
    0 0,
    0 10px,
    10px -10px,
    -10px 0;
}

/* 平移模式：光标提示可拖动 */
.stage.panning {
  cursor: grab;
}

.canvas-scroll {
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  /* 画布自身可能大于容器（放大后），让它溢出而不是压缩 */
  max-width: 100%;
  max-height: 100%;
}

.canvas-host {
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: 0 4px 24px rgb(0 0 0 / 18%);
  /* 触摸设备上禁用默认手势，否则拖动会被当成滚动 */
  touch-action: none;
}

.hint {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  margin: 0;
  color: var(--md-sys-color-on-surface-variant);
  pointer-events: none;
}

.hint.error {
  color: var(--md-sys-color-error);
}

/* ---- 右侧属性面板 ---- */
.panel {
  flex: 0 0 200px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 12px;
  overflow-y: auto;
  background: var(--md-sys-color-surface-container-low);
  border-left: 1px solid var(--md-sys-color-outline-variant);
}

.panel-block {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 0 14px;
  border-bottom: 1px solid var(--md-sys-color-outline-variant);
}

.panel-block:last-child {
  border-bottom: none;
}

.panel-title {
  margin: 0;
  font-size: 12px;
  font-weight: 600;
  color: var(--md-sys-color-on-surface-variant);
}

.swatches {
  display: grid;
  grid-template-columns: repeat(6, 1fr);
  gap: 6px;
}

.swatch {
  width: 100%;
  aspect-ratio: 1;
  padding: 0;
  border: none;
  border-radius: 999px;
  cursor: pointer;
  box-shadow: inset 0 0 0 1px var(--lm-hairline);
}

.swatch.on {
  box-shadow:
    inset 0 0 0 1px var(--lm-hairline),
    0 0 0 2px var(--md-sys-color-primary);
}

.picker-row {
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
}

.picker {
  width: 28px;
  height: 28px;
  padding: 0;
  border: 1px solid var(--md-sys-color-outline-variant);
  border-radius: 8px;
  background: none;
  cursor: pointer;
}

.picker-text {
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  color: var(--md-sys-color-on-surface-variant);
}

.info-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 12px;
  color: var(--md-sys-color-on-surface-variant);
}

.info-value {
  font-variant-numeric: tabular-nums;
  color: var(--md-sys-color-on-surface);
}

.hints .hint-row {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  color: var(--md-sys-color-on-surface-variant);
}

.hints kbd {
  padding: 1px 5px;
  font-family: inherit;
  font-size: 10px;
  color: var(--md-sys-color-on-surface);
  background: var(--md-sys-color-surface-container-high);
  border: 1px solid var(--md-sys-color-outline-variant);
  border-radius: 4px;
}
</style>
