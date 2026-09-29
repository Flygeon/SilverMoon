/**
 * Flutter WebView 垫片。
 *
 * 桌面端渲染进程访问宿主环境只有一条路径：window.__SILVERMOON__。
 * 这里在 Vue 启动前把它装上，转发到 Flutter 侧注入的 JavaScript 通道。
 *
 * 通道协议（与 apps/mobile 的 bridge_service.dart 约定）：
 *   请求  { id, kind: "invoke" | "invokeBatch" | "call" | "emitTo", ... }
 *   回复  { id, ok, data?, error? }
 *   事件  { kind: "event", event, payload }
 *
 * 二进制约定：JSON 过不了 TypedArray，所以双向都做一层 __b64 包装，
 * 在这里还原成真正的 Uint8Array —— 这样 bridge.ts 的 toBytes() 拿到的仍是字节，
 * 而不是被 UTF-8 化的字符串（桌面端历史上正是踩了这个坑导致逐字歌词全挂）。
 */
export {};

type Reply = { ok: boolean; data?: unknown; error?: string };

interface Pending {
  resolve: (r: Reply) => void;
}

declare global {
  interface Window {
    __SM_REPLY__?: (id: number, replyJson: string) => void;
    __SM_EVENT__?: (name: string, payloadJson: string) => void;
    __SM_NATIVE__?: { postMessage: (s: string) => void };
    SMNative?: { postMessage: (s: string) => void };
  }
}

// ------------------------------------------------------------------ 二进制

function bytesToB64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000; // 分块，避免超长参数导致栈溢出
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function b64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

/** 出站：TypedArray / ArrayBuffer 打成 { __b64 }。 */
function encodeValue(v: unknown): unknown {
  if (v instanceof Uint8Array) return { __b64: bytesToB64(v) };
  if (v instanceof ArrayBuffer) return { __b64: bytesToB64(new Uint8Array(v)) };
  if (ArrayBuffer.isView(v)) {
    const view = v as ArrayBufferView;
    return { __b64: bytesToB64(new Uint8Array(view.buffer, view.byteOffset, view.byteLength)) };
  }
  if (Array.isArray(v)) return v.map(encodeValue);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) out[k] = encodeValue(val);
    return out;
  }
  return v;
}

/** 入站：把 { __b64 } 还原成 Uint8Array，其余原样递归。 */
function decodeValue(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(decodeValue);
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (typeof o.__b64 === "string") return b64ToBytes(o.__b64);
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(o)) out[k] = decodeValue(val);
    return out;
  }
  return v;
}

// ------------------------------------------------------------------ 传输

const pending = new Map<number, Pending>();
let seq = 0;

window.__SM_REPLY__ = (id: number, replyJson: string) => {
  const p = pending.get(id);
  if (!p) return;
  pending.delete(id);
  try {
    const raw = JSON.parse(replyJson) as Reply;
    p.resolve({ ok: raw.ok, data: decodeValue(raw.data), error: raw.error });
  } catch (e) {
    p.resolve({ ok: false, error: String(e) });
  }
};

window.__SM_EVENT__ = (name: string, payloadJson: string) => {
  let payload: unknown = null;
  try {
    payload = JSON.parse(payloadJson);
  } catch {
    payload = null;
  }
  window.dispatchEvent(new CustomEvent("silvermoon:native", { detail: { name, payload } }));
};

/** 通道对象由 WebView 在文档开始时注入，稍等一会儿是正常的。 */
function nativeChannel(): Promise<{ postMessage: (s: string) => void }> {
  return new Promise((resolve) => {
    const probe = (tries: number) => {
      const n = window.SMNative;
      if (n && typeof n.postMessage === "function") {
        resolve(n);
        return;
      }
      if (tries <= 0) {
        resolve({ postMessage: () => {} });
        return;
      }
      setTimeout(() => probe(tries - 1), 25);
    };
    probe(120); // 最多等 3 秒
  });
}

function send(kind: string, payload: Record<string, unknown>): Promise<Reply> {
  const id = ++seq;
  return new Promise<Reply>((resolve) => {
    pending.set(id, { resolve });
    void nativeChannel().then((native) => {
      native.postMessage(JSON.stringify(encodeValue({ id, kind, ...payload })));
    });
    // 兜底：20 秒未回包就失败，避免 UI 永久挂起
    setTimeout(() => {
      if (pending.delete(id)) resolve({ ok: false, error: "BRIDGE_TIMEOUT" });
    }, 20000);
  });
}

// ------------------------------------------------------------ 安装宿主接口

/**
 * 本地文件 URL 前缀。桌面端是 Electron 的 asset:// 协议，
 * 移动端指向 Flutter 起的 loopback HTTP 服务（支持 Range，音视频可拖动进度）。
 * ipc/invoke.ts 的 toAssetUrl() 会读它。
 */
const assetBase = ((): string => {
  const meta = document.querySelector('meta[name="sm-asset-base"]');
  return meta ? meta.getAttribute("content") ?? "" : "";
})();

window.__SILVERMOON__ = {
  label: "main",
  platform: "android",
  assetBase: assetBase || undefined,
  invoke: (cmd: string, args: unknown) => send("invoke", { cmd, args }),
  invokeBatch: (calls: unknown) => send("invokeBatch", { calls }),
  call: (channel: string, payload: unknown) => send("call", { channel, payload }),
  emitTo: async (label: string, event: string, payload: unknown) => {
    await send("emitTo", { label, event, payload });
  },
} as never;

// 通知宿主：垫片已就位
window.dispatchEvent(new CustomEvent("silvermoon:shim-ready"));
