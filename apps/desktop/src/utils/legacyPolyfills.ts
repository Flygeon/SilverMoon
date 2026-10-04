/**
 * Chromium 108（Electron 22）缺失的 Web 平台能力补齐。
 *
 * ## 背景
 *
 * Win7 兼容版停在 Electron 22 → **Chromium 108**。实测（在真实 Electron 22 里
 * 查 `CSS.supports` 与全局）确认两个缺口会影响功能：
 *
 * 1. `Promise.withResolvers()` —— **Chrome 119** 才有的方法（实测 undefined）。
 *    `pdfjs-dist@6` 内部大量使用（pdf.mjs 11 处、pdf.worker.mjs 30 处），
 *    缺失时打开 PDF 会直接 `TypeError: Promise.withResolvers is not a function`。
 *    这里补一个等价实现即可（语义简单，无副作用）。
 *
 * 2. `color-mix()` —— **Chrome 111** 才有（实测 `CSS.supports` 为 false）。
 *    本项目 13 个文件 52 处、以及 `@m3e/web` 大量使用。缺它时**不会报错**，
 *    对应声明被静默丢弃 → MD3 主题色失真（发灰 / 透明 / 回退到原色）。
 *    颜色无法在运行期可靠地「补出 CSS 函数」，因此这里做的是**能力探测 + 标注**，
 *    由样式层用 `@supports` 提供近似回退（见 `src/tokens/legacy.css`）。
 *
 * 其余实测在 Chromium 108 上**可用**、无需 polyfill 的：
 * `:has()`、容器查询、`structuredClone`、`createImageBitmap`、`OffscreenCanvas`、fetch。
 */

/** 给 Chromium < 119 补 `Promise.withResolvers`。 */
function installWithResolvers(): void {
  const P = Promise as unknown as {
    withResolvers?: <T>() => {
      promise: Promise<T>;
      resolve: (value: T | PromiseLike<T>) => void;
      reject: (reason?: unknown) => void;
    };
  };
  if (typeof P.withResolvers === "function") return;

  P.withResolvers = function withResolvers<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  };
}

/** 是否支持 `color-mix()`（Chromium 111+）。 */
export function supportsColorMix(): boolean {
  try {
    return CSS.supports("color", "color-mix(in srgb, red, blue)");
  } catch {
    return false;
  }
}

/**
 * 安装全部运行时 polyfill。
 *
 * 幂等，且在 `main.ts` 最顶部同步调用 —— 必须早于任何 PDF 相关代码路径。
 */
export function installLegacyPolyfills(): void {
  installWithResolvers();

  // 供样式/组件按需判断，避免在 JS 里反复调 CSS.supports
  const root = document.documentElement;
  if (!supportsColorMix()) {
    root.setAttribute("data-legacy-color-mix", "off");
  }
}
