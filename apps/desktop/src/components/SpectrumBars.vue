<script setup lang="ts">
/**
 * 无歌词时的实时频谱（桌面歌词窗口用）。
 *
 * ## 数据从哪来
 *
 * 不走 native、也不走主窗口 —— 直接在**本窗口**接入音频分析：
 * 桌面歌词窗口是独立渲染进程，它自己没有 audio 元素，所以这里只能由
 * 主窗口把分析结果推过来，或由本窗口自建 AudioContext。
 *
 * 实际采用的是前者：主窗口的 player store 已经有一条到音频元素的链路
 * （见 utils/spectrum.ts 复用 audioEffects 的 AudioContext），
 * 频谱值随歌词状态一起下发。这样**不引入第二条音频链路**，
 * 也不会因为多开一个 AudioContext 而出现设备占用/回音问题。
 *
 * 之所以做成组件而不是写在 DesktopLyrics.vue 里：频谱的 canvas 绘制、
 * 尺寸自适应、rAF 生命周期是独立关注点，抽出来便于单测与复用。
 */
import { onBeforeUnmount, onMounted, ref, watch } from "vue";

const props = withDefaults(
  defineProps<{
    /** 频谱数据：长度 64、取值 0-255；null 表示暂无数据 */
    bins: number[] | null;
    /** 是否正在播放（暂停时冻结画面，不继续抽新帧） */
    playing?: boolean;
    /** 柱状图颜色 */
    color?: string;
  }>(),
  {
    playing: true,
    color: "rgba(255, 255, 255, 0.85)",
  },
);

const canvasRef = ref<HTMLCanvasElement | null>(null);
let rafId: number | null = null;
let ctx: CanvasRenderingContext2D | null = null;
/** 上一帧的柱高，用于做平滑下落（否则柱子在 5Hz 数据下会跳变） */
let smoothed: number[] = [];

const BARS = 32;

/**
 * 把 64 个 bin 折叠成 32 根柱子。
 *
 * 相邻两个取较大值而不是平均：平均会把能量抹平，低音区看起来一片矮；
 * 取较大值保留峰值，观感更「有跳动感」。
 */
function fold(bins: number[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < BARS; i++) {
    const a = bins[i * 2] ?? 0;
    const b = bins[i * 2 + 1] ?? 0;
    out.push(Math.max(a, b) / 255);
  }
  return out;
}

function resize(): void {
  const canvas = canvasRef.value;
  if (!canvas) return;
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  // 物理像素对齐，避免高分屏上柱状图糊成一片
  canvas.width = Math.max(1, Math.round(rect.width * dpr));
  canvas.height = Math.max(1, Math.round(rect.height * dpr));
  ctx = canvas.getContext("2d");
  if (ctx) ctx.scale(dpr, dpr);
}

function draw(): void {
  const canvas = canvasRef.value;
  if (!canvas || !ctx) return;
  const rect = canvas.getBoundingClientRect();
  const w = rect.width;
  const h = rect.height;
  ctx.clearRect(0, 0, w, h);

  const target = props.bins ? fold(props.bins) : new Array(BARS).fill(0);

  // 上升立即跟手、下降做缓动：这是频谱看起来「活」的关键，
  // 5Hz 的数据源不做插值会明显一格一格跳。
  if (smoothed.length !== BARS) smoothed = new Array(BARS).fill(0);
  for (let i = 0; i < BARS; i++) {
    const t = target[i] ?? 0;
    smoothed[i] = t > smoothed[i] ? t : smoothed[i] * 0.75 + t * 0.25;
  }

  const gap = 2;
  const barW = Math.max(1, (w - gap * (BARS - 1)) / BARS);
  ctx.fillStyle = props.color;
  for (let i = 0; i < BARS; i++) {
    const value = smoothed[i];
    // 最低留 2px，否则静音时整排柱子完全消失、看起来像坏了
    const barH = Math.max(2, value * h);
    const x = i * (barW + gap);
    const y = h - barH;
    ctx.fillRect(x, y, barW, barH);
  }
}

function loop(): void {
  draw();
  rafId = requestAnimationFrame(loop);
}

function start(): void {
  if (rafId !== null) return;
  rafId = requestAnimationFrame(loop);
}

function stop(): void {
  if (rafId === null) return;
  cancelAnimationFrame(rafId);
  rafId = null;
}

onMounted(() => {
  resize();
  // 暂停时仍画一帧，让画面停在当前位置而不是黑掉
  draw();
  if (props.playing) start();
  window.addEventListener("resize", resize);
});

watch(
  () => props.playing,
  (playing) => {
    if (playing) start();
    else stop();
  },
);

onBeforeUnmount(() => {
  stop();
  window.removeEventListener("resize", resize);
});
</script>

<template>
  <canvas ref="canvasRef" class="spectrum-bars" aria-hidden="true"></canvas>
</template>

<style scoped>
.spectrum-bars {
  display: block;
  width: 100%;
  height: 100%;
  opacity: 0.9;
}
</style>
