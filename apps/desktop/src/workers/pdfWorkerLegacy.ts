/**
 * pdf.js worker 的兼容入口（Chromium 108 / Electron 22）。
 *
 * ## 为什么需要单独一层
 *
 * pdf.js 的 worker 跑在**独立 Worker 上下文**里，主窗口 `main.ts` 里装的
 * `Promise.withResolvers` polyfill **不会**传播过来。而
 * `pdfjs-dist@6` 的 `pdf.worker.mjs` 里有 30 处 `Promise.withResolvers()`
 * （实测 Chromium 108 上是 undefined），worker 一启动就会抛 TypeError。
 *
 * 这里做成一个「先补丁、后加载」的入口：先同步装上 polyfill，再用**动态**
 * import 拉真正的 worker（用静态 import 会被提升到补丁之前，等于没补）。
 *
 * 现代版（Chromium 119+）下 `withResolvers` 已存在，补丁函数直接返回，
 * 行为与直接用官方 worker 完全一致 —— 因此这条入口**两个版本共用**。
 */
function installWithResolvers(): void {
  const P = Promise as unknown as { withResolvers?: unknown };
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

installWithResolvers();

// 动态 import：确保上面的补丁先于 pdf.worker 的模块求值执行。
// 顶层 await 在 ES module worker 里可用（Chromium 89+，构建目标已钉 chrome108）。
//
// `export {}` 让它成为一个 module：否则 TS 不认这里的顶层 await（TS1375）。
await import("pdfjs-dist/build/pdf.worker.mjs" as string);

export {};
