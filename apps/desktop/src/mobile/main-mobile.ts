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
// 必须在任何 new Audio() 之前装上替身。new Audio() 发生在挂载后的
// initAudio()，所以放在模块顶部即可 —— 但顺序仍保持在前，免得以后
// 有人在模块求值期就建元素。
import "./audio-shim";

// 设计令牌层必须和桌面入口一样引入，且顺序相同（fonts 先于 theme）。
// 漏掉的后果不是「样式差一点」，而是整层缺失：
//   - theme.css 里的 @font-face 没了 → Material 图标退化成字面文字
//     （界面上直接显示 search / grid_view / music_note 这些连字名）
//   - --md-sys-* 全部未定义 → 所有 var() 落到各自 fallback，
//     看起来「深色还能看」其实全是兜底色，不是真主题
import "@/tokens/fonts.css";
import "@/tokens/theme.css";

import "./mobile.css";

import { createApp, watch } from "vue";
import { createPinia } from "pinia";
import { createRouter, createWebHashHistory } from "vue-router";

import MobileApp from "./MobileApp.vue";
import { usePlayerStore } from "@/stores/player";
import { useSettingsStore } from "@/stores/settings";
import { invoke } from "@/ipc/invoke";

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

// 主题必须在 mount 之前解析。桌面端是在 App.vue 的 onMounted 里调的，
// 移动端不走 App.vue，所以必须在这里补 —— 否则 <html> 上的 data-theme
// 永远不设置，theme.css 的浅色 :root 令牌就成了实际生效的那一套。
//
// 先用默认值同步解析一次（默认 system，跟随系统深浅色），避免挂载后
// 再切主题导致闪一下浅色；落盘的偏好读回来之后再解析一次覆盖它。
const settings = useSettingsStore();
settings.applyTheme(settings.theme);
void settings.load().then(() => settings.applyTheme(settings.theme));
void alignScanDirs();

// 桌面端的扫描根是用户在设置里一个个加的；移动端没有那个目录选择器，
// 路径由原生按平台给（Android 是 Music/Download/网易云/QQ/酷狗，
// iOS 是 App 文档目录，见 bridge_commands.dart 的 _defaultDirs）。
//
// 这里**每次启动都对齐**，而不是「空了才填」：iOS 的容器路径里带 UUID，
// 重装或升级 App 之后文档目录会换一个，持久化下来的旧绝对路径就永久失效了，
// 表现为「明明配了目录却扫不到东西」这种很难查的问题。
async function alignScanDirs(): Promise<void> {
  try {
    const dirs = await invoke<string[]>("library_default_dirs");
    if (!Array.isArray(dirs) || dirs.length === 0) return;
    if (dirs.join('\n') === settings.scanDirs.join('\n')) return;
    settings.scanDirs = dirs;
  } catch (e) {
    console.warn("[sm] 获取默认扫描目录失败", e);
  }
}

app.mount("#app");

// ── 与 Flutter 原生的双向通道 ────────────────────────────────────────
//
// 播放逻辑（队列、歌词、UI）留在 WebView，音频输出交给 Flutter 的 just_audio
// —— 见 audio-shim.ts 与 apps/mobile/lib/services/web_audio_host.dart。
// 这样息屏后音频继续播，通知栏和锁屏有控制。
//
// 这里把状态镜像给原生：原生迷你播放器用它，音频出口用它填 MediaItem
// （通知栏的标题/歌手/封面）。

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
