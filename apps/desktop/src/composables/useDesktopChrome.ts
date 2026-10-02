/**
 * 桌面 chrome：窗口关闭拦截（最小化到托盘）、托盘播放器命令分发、
 * 应用内热键（窗口聚焦时生效，输入框内自动忽略）。
 *
 * 与 SMTC 系统媒体键共享同一套 player store 动作；托盘/热键只在
 * 桌面环境生效，浏览器预览全部 no-op。
 */
import { onBeforeUnmount, onMounted } from "vue";
import { getCurrentWindow } from "@/ipc/window";
import { capabilities, isDesktop } from "@/capabilities";
import { usePlayerStore } from "@/stores/player";
import { useSettingsStore } from "@/stores/settings";

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

/**
 * 当前是否有一个「抢占全局快捷键」的浮层开着。
 *
 * B 站视频详情 / UP 主主页、在线番剧播放器、媒体查看器等都是全屏浮层，里面自带
 * ArtPlayer / <video>，它们自己也绑了空格（播放暂停）。而这些浮层**不经过路由**，
 * 只是 DOM 上的 fixed 层，所以全局热键必须显式让位。
 *
 * 不让位的后果就是用户看到的：在 B 站视频页按空格，**后台音乐和视频一起暂停**。
 *
 * 判据取「可见的视频元素」：
 * - ArtPlayer 的容器统一带 `.art-video-player` 类（B 站播放器、番剧播放器都用它）；
 * - 媒体查看器（MediaViewer）用的是裸 `<video>`。
 *
 * 只认「有实际尺寸」的元素：B 站详情页即使没在播，ArtPlayer 容器也挂着，
 * 此时让位同样合理（空格在手，用户想控制的一定是眼前这个播放器）。尺寸判断是为了
 * 排除隐藏起来的播放器（例如 KeepAlive 缓存里移出文档的旧实例）。
 */
function hasForegroundMedia(): boolean {
  if (typeof document === "undefined") return false;
  const players = document.querySelectorAll<HTMLElement>(".art-video-player, video");
  for (const el of players) {
    if (el.offsetWidth > 0 && el.offsetHeight > 0) return true;
  }
  return false;
}

export function useDesktopChrome() {
  const settings = useSettingsStore();
  const player = usePlayerStore();

  const unlisteners: (() => void)[] = [];

  function handlePlayerCommand(action: string) {
    if (!player.song) return;
    switch (action) {
      case "play":
        if (!player.playing) player.togglePlay();
        break;
      case "pause":
        if (player.playing) player.togglePlay();
        break;
      case "toggle":
        player.togglePlay();
        break;
      case "next":
        void player.next();
        break;
      case "prev":
        void player.previous();
        break;
      default:
        break;
    }
  }

  function onKeyDown(event: KeyboardEvent) {
    if (isTypingTarget(event.target)) return;

    // F12 开发者工具（仅设置中开启时生效）
    if (event.key === "F12") {
      if (localStorage.getItem("lumiluna-devtools-enabled") === "1") {
        event.preventDefault();
        void capabilities.openDevtools();
      }
      return;
    }

    if (!player.song) return;

    // 前台有视频/番剧播放器浮层时让位：空格归它（它自己绑了 toggle），
    // 否则会「后台音乐和视频同时暂停」。
    if (hasForegroundMedia()) return;

    if (event.code === "Space") {
      event.preventDefault();
      player.togglePlay();
      return;
    }

    if (!event.ctrlKey) return;
    switch (event.code) {
      case "ArrowLeft":
        event.preventDefault();
        player.seek(Math.max(0, player.currentTime - 5));
        break;
      case "ArrowRight":
        event.preventDefault();
        player.seek(
          Math.min(
            Number.isFinite(player.duration) ? player.duration : Number.MAX_SAFE_INTEGER,
            player.currentTime + 5,
          ),
        );
        break;
      default:
        break;
    }
  }

  onMounted(async () => {
    if (!isDesktop) return;

    let win: ReturnType<typeof getCurrentWindow>;
    try {
      win = getCurrentWindow();
    } catch {
      return;
    }

    // 只在主窗口挂桌面 chrome；桌面歌词等子窗口自己负责关闭，
    // 否则关闭拦截会把子窗口错误地 hide 掉，导致歌词窗关不掉。
    if (win.label !== "main") return;

    try {
      const unlistenClose = await win.onCloseRequested(async (event) => {
        event.preventDefault();
        if (settings.closeToTray) {
          await win.hide().catch(() => {});
        } else {
          await capabilities.exitApp();
        }
      });
      unlisteners.push(unlistenClose);
    } catch {
      /* 权限不足时静默 */
    }

    try {
      const unlistenCommands = await capabilities.onAppPlayerCommand(handlePlayerCommand);
      unlisteners.push(unlistenCommands);
    } catch {
      /* 静默 */
    }

    window.addEventListener("keydown", onKeyDown);
  });

  onBeforeUnmount(() => {
    window.removeEventListener("keydown", onKeyDown);
    unlisteners.forEach((un) => un());
    unlisteners.length = 0;
  });
}
