/**
 * Windows 样式标题栏的窗口控制：最小化 / 最大化 / 关闭 + 最大化态跟踪。
 *
 * ## 为什么这里没有拖拽
 *
 * 标题栏与播放页顶栏的拖拽改用 `-webkit-app-region: drag` 交给系统原生处理，
 * 本模块只保留窗口控制按钮。早期版本用 pointermove + 每帧 IPC `setPosition`
 * 自搬窗口（`useWindowDrag`），有两个硬伤，已整体删除：
 *
 * 1. **单位混用**：`PointerEvent.screenX` 是 CSS 像素，而 `outerPosition()`
 *    按物理像素进出（见 `ipc/window.ts` 的坐标系说明）。把 CSS 像素的位移
 *    直接加到物理像素的窗口坐标上，非 100% 缩放下窗口只走 `1 / scale` 的距离
 *    （150% 缩放走 2/3，200% 缩放走 1/2），越拖越偏。
 * 2. **每帧一次 IPC 往返**：`setPosition` 的返回值为 null，回复无用却要等；
 *    且每次 `setPosition` 都会触发主进程 `win.on("move")`——内部要做
 *    `screen.getDisplayMatching` + 派发一个主窗口无人消费的 `window:move`。
 *    主进程越忙拖拽越迟钝，是正反馈。
 *
 * 原生方案零 IPC、零 JS，且额外白拿 Aero Snap（拖到屏幕边缘吸附）与
 * 双击最大化——这两样自搬窗口都做不到。
 *
 * 与 `ExtensionHost.vue` / `DesktopLyrics.vue` 的既有做法保持一致。
 */
import { onBeforeUnmount, onMounted, ref } from "vue";
import { getCurrentWindow } from "@/ipc/window";

export function useWindowControls() {
  const isMaximized = ref(false);

  let appWindow: ReturnType<typeof getCurrentWindow> | null = null;
  try {
    appWindow = getCurrentWindow();
  } catch {
    /* 浏览器预览无宿主桥 */
  }

  let unlistenResized: (() => void) | null = null;

  onMounted(async () => {
    if (!appWindow) return;
    try {
      isMaximized.value = await appWindow.isMaximized();
      // 原生拖拽下的双击最大化 / Aero Snap 同样会改变尺寸，靠 resize 同步状态
      unlistenResized = await appWindow.onResized(() => {
        void appWindow!.isMaximized().then((m) => (isMaximized.value = m));
      });
    } catch {
      /* 忽略 */
    }
  });

  onBeforeUnmount(() => {
    if (unlistenResized) {
      unlistenResized();
      unlistenResized = null;
    }
  });

  function minimize() {
    if (!appWindow) return;
    void appWindow.minimize().catch(() => {});
  }

  function toggleMaximize() {
    if (!appWindow) return;
    void (async () => {
      try {
        await appWindow!.toggleMaximize();
        isMaximized.value = await appWindow!.isMaximized();
      } catch {
        /* 忽略 */
      }
    })();
  }

  function close() {
    if (!appWindow) return;
    void appWindow.close().catch(() => {});
  }

  return { isMaximized, minimize, toggleMaximize, close };
}
