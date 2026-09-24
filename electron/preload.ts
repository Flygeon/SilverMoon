/**
 * 预加载脚本（主窗口与普通子窗口）。
 *
 * 职责有三个：
 *
 * 1. 通过 `contextBridge` 暴露 `window.__SILVERMOON__` —— 渲染进程唯一的对外通道；
 * 2. 注入 `window.__TAURI_INTERNALS__` —— 业务代码用
 *    `"__TAURI_INTERNALS__" in window` 作为「是否运行在原生壳里」的判据
 *    （`src/capabilities/index.ts` 的 `isTauri`，约 40 处依赖），注入后
 *    所有原生能力分支会自动生效，前端无需改动；
 * 3. 把主进程推来的事件转成 DOM `CustomEvent`，并接管文件拖放（取真实路径）。
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

// 让业务代码的 `isTauri` 探测成立。这里只需要「存在」，不暴露任何能力。
contextBridge.exposeInMainWorld("__TAURI_INTERNALS__", {
  metadata: { currentWindow: { label }, currentWebview: { label } },
});

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
 * 这里把 DOM 拖放事件翻译成与 Tauri 同名、同形状的事件，
 * 于是 `App.vue` 里 `getCurrentWebview().onDragDropEvent(...)` 的代码无需改动。
 */
function emitDrag(frame: {
  type: "enter" | "over" | "drop" | "leave";
  paths?: string[];
  position?: { x: number; y: number };
}): void {
  const eventName = `tauri://drag-${frame.type}`;
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
