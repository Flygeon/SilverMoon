/**
 * 移动端（Flutter WebView）入口。
 *
 * 与桌面入口共用全部 stores / components / utils，只替换外壳：
 * - 移动端自己的 hash 路由，只注册音乐相关页面
 * - 不加载皮肤、窗口边框、桌面歌词窗口等桌面专有逻辑
 *
 * 顺序很重要：shim 必须在任何 store 被 import 之前安装 window.__SILVERMOON__。
 */
import "./shim";
import "./mobile.css";

import { createApp, watch } from "vue";
import { createPinia } from "pinia";
import { createRouter, createWebHashHistory } from "vue-router";

import MobileApp from "./MobileApp.vue";
import { usePlayerStore } from "@/stores/player";

const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: "/", redirect: "/music" },
    { path: "/music", component: () => import("@/views/MusicView.vue") },
    { path: "/music/player", component: () => import("@/views/PlayerView.vue") },
  ],
});

const app = createApp(MobileApp);
app.use(createPinia());
app.use(router);
app.mount("#app");

// ── 与 Flutter 原生的双向通道 ────────────────────────────────────────
//
// 播放引擎仍然在 WebView 里（就是桌面端那一套 <audio> + Web Audio），
// 这里只把状态镜像给原生：原生负责迷你播放器，后续接通知栏与耳机线控。

interface NativeChannel {
  postMessage: (s: string) => void;
}
const native: NativeChannel | undefined = window.SMNative;

function post(event: string, payload: unknown): void {
  native?.postMessage(JSON.stringify({ kind: "event", event, payload }));
}

const player = usePlayerStore();

function pushPlayerState(): void {
  const s = player.song;
  post("player:state", {
    hasTrack: !!s,
    playing: player.playing,
    title: s?.title ?? "",
    artist: s?.artist ?? "",
    // 本地歌曲的封面是 dataURL（可能上百 KB），每次心跳都送过去不划算，
    // 原生迷你播放器对本地曲目显示占位图即可。
    coverUrl: s?.coverUrl ?? (s?.cover?.startsWith("http") ? s.cover : ""),
    positionMs: Math.round((player.currentTime ?? 0) * 1000),
    durationMs: Math.round((player.duration ?? 0) * 1000),
  });
}

watch(
  () => [player.song, player.playing, player.currentTime, player.duration],
  pushPlayerState,
);

// 原生发来的播放控制（迷你播放器、通知栏、耳机线控）
window.addEventListener("silvermoon:native", ((ev: CustomEvent) => {
  const detail = ev.detail as { name?: string; payload?: unknown } | undefined;
  if (!detail || detail.name !== "player:command") return;
  const cmd = detail.payload;
  if (cmd === "toggle") void player.togglePlay();
  else if (cmd === "next") void player.next();
  else if (cmd === "prev") void player.previous();
  else if (cmd && typeof cmd === "object") {
    const c = cmd as { op?: string; value?: number };
    if (c.op === "seek" && typeof c.value === "number") player.seek(c.value);
  }
}) as EventListener);

post("app:ready", null);
pushPlayerState();
