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
  // electron 由运行时提供，不能打进包
  external: ["electron"],
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
