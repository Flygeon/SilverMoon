/**
 * 预加载脚本（主窗口与普通子窗口）。
 *
 * 职责有三个：
 *
 * 1. 通过 `contextBridge` 暴露 `window.__SILVERMOON__` —— 渲染进程唯一的对外通道，
 *    业务代码以它的存在性判断「是否运行在桌面宿主里」（`src/capabilities/index.ts`
 *    的 `isDesktop`）；
 * 2. 把主进程推来的事件转成 DOM `CustomEvent`；
 * 3. 接管文件拖放：新版 Electron 不再提供 `File.path`，必须在这里用
 *    `webUtils.getPathForFile()` 把 `File` 换成真实路径。
 */
import { contextBridge, ipcRenderer, webUtils } from "electron";

interface BridgeReply {
  ok: boolean;
  data?: unknown;
  error?: string;
}

function readArg(prefix: string): string | null {
  const hit = process.argv.find((arg) => arg.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : null;
}

const label = readArg("--silvermoon-label=") ?? "main";

const bridge = {
  label,
  platform: process.platform,
  invoke: (cmd: string, args: unknown): Promise<BridgeReply> =>
    ipcRenderer.invoke("sm:invoke", { cmd, args }),
  call: (channel: string, payload: unknown): Promise<BridgeReply> =>
    ipcRenderer.invoke("sm:call", { channel, payload }),
  emitTo: async (target: string, event: string, payload: unknown): Promise<void> => {
    await ipcRenderer.invoke("sm:emit", { label: target, event, payload });
  },
};

contextBridge.exposeInMainWorld("__SILVERMOON__", bridge);

// ---------------------------------------------------------------------------
// 主进程 → 渲染进程事件
// ---------------------------------------------------------------------------

ipcRenderer.on("sm:event", (_event, frame: unknown) => {
  // preload 与页面共享同一个 window 对象，所以可以直接派发 DOM 事件，
  // 无需为每次 listen 建一条 IPC 通道。
  window.dispatchEvent(new CustomEvent("silvermoon:event", { detail: frame }));
});

// ---------------------------------------------------------------------------
// 文件拖放
// ---------------------------------------------------------------------------

/**
 * 新版 Electron 不再提供 `File.path`，必须用 `webUtils.getPathForFile()`。
 * 这里把 DOM 拖放事件翻译成 `drop:*` 事件，
 * 于是 `App.vue` 里 `onDragDropEvent(...)` 的代码无需改动。
 */
function emitDrag(frame: {
  type: "enter" | "over" | "drop" | "leave";
  paths?: string[];
  position?: { x: number; y: number };
}): void {
  const eventName = `drop:${frame.type}`;
  window.dispatchEvent(
    new CustomEvent("silvermoon:event", {
      detail: {
        event: eventName,
        target: label,
        payload: {
          type: frame.type,
          ...(frame.paths ? { paths: frame.paths } : {}),
          ...(frame.position ? { position: frame.position } : {}),
        },
      },
    }),
  );
}

function pathsOf(list: FileList | null): string[] {
  if (!list) return [];
  const out: string[] = [];
  for (const file of Array.from(list)) {
    try {
      const path = webUtils.getPathForFile(file);
      if (path) out.push(path);
    } catch {
      /* 非磁盘文件（如浏览器内拖拽的虚拟文件）忽略 */
    }
  }
  return out;
}

let dragging = false;

window.addEventListener("dragenter", (event) => {
  const paths = pathsOf(event.dataTransfer?.files ?? null);
  dragging = true;
  emitDrag({ type: "enter", paths });
});

window.addEventListener("dragover", (event) => {
  if (!dragging) return;
  event.preventDefault();
  emitDrag({ type: "over", paths: pathsOf(event.dataTransfer?.files ?? null) });
});

window.addEventListener("dragleave", (event) => {
  // 只在真正离开窗口时算 leave（子元素间移动也会触发 dragleave）
  if (event.relatedTarget === null) {
    dragging = false;
    emitDrag({ type: "leave" });
  }
});

window.addEventListener("drop", (event) => {
  event.preventDefault();
  dragging = false;
  const paths = pathsOf(event.dataTransfer?.files ?? null);
  emitDrag({ type: "drop", paths });
});
