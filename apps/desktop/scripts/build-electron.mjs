/**
 * 用 esbuild 把 Electron 主进程与预加载脚本打成 CJS。
 *
 * 为什么打成 CJS 而不是直接用 tsc 输出 ESM：
 * - `package.json` 里是 `"type": "module"`，ESM 主进程在 electron-builder 打包
 *   与 `preload`（必须是 CJS）上都有额外坑；
 * - 打成单文件后产物只有 main.cjs / preload.cjs / webview-preload.cjs 三个，
 *   `__dirname` 语义稳定，协议处理器与缓存目录定位都不必再处理路径问题。
 */
import { build } from "esbuild";
import { rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const watch = process.argv.includes("--watch");

const shared = {
  bundle: true,
  platform: "node",
  // 与 Electron 内置的 Node 版本对齐（Electron 44 → Node 22）
  target: "node22",
  format: "cjs",
  outdir: path.join(root, "dist-electron"),
  outExtension: { ".js": ".cjs" },
  // CJS 里没有 import.meta：esbuild 会把 `import.meta` 替换成 {}（并报一条警告），
  // 于是 electron/tag-writer.ts 定位 wasm 时只能靠 `__filename`（CJS 产物本就有）。
  // 这里显式定义掉，既消掉警告，也让「CJS 走 __filename」成为确定行为；
  // 验证脚本打 ESM 时用的是另一套配置，import.meta.url 保持真实值。
  define: { "import.meta.url": "undefined" },
  // electron 由运行时提供，不能打进包。
  //
  // taglib-wasm 是 **ESM-only**，而这里打的是 CJS：必须保持 external，
  // 运行时由 `await import("taglib-wasm")` 加载（见 electron/tag-writer.ts）。
  // 一旦被 bundle 进来，它内部的 `import.meta.url` / `createRequire` 兜底路径
  // 就会被 esbuild 改写成 {}（实测），wasm 定位必挂。
  external: ["electron", "taglib-wasm", "taglib-wasm/simple"],
  sourcemap: watch ? "inline" : false,
  minify: !watch,
  logLevel: "info",
};

const entries = ["electron/main.ts", "electron/preload.ts", "electron/webview-preload.ts"].map(
  (rel) => path.join(root, rel),
);

if (!watch) {
  rmSync(path.join(root, "dist-electron"), { recursive: true, force: true });
}

if (watch) {
  const { context } = await import("esbuild");
  const ctx = await context({ ...shared, entryPoints: entries });
  await ctx.watch();
  console.log("[build-electron] 监听模式已启动");
} else {
  await build({ ...shared, entryPoints: entries });
  console.log("[build-electron] 构建完成 → dist-electron/");
}
