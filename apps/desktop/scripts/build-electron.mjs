/**
 * 用 esbuild 把 Electron 主进程与预加载脚本打成 CJS。
 *
 * 为什么打成 CJS 而不是直接用 tsc 输出 ESM：
 * - `package.json` 里是 `"type": "module"`，ESM 主进程在 electron-builder 打包
 *   与 `preload`（必须是 CJS）上都有额外坑；
 * - 打成单文件后产物只有 main.cjs / preload.cjs / webview-preload.cjs 三个，
 *   `__dirname` 语义稳定，协议处理器与缓存目录定位都不必再处理路径问题。
 *
 * ## 双目标（`--win7`）
 *
 * Win7 兼容版必须停在 Electron 22（内置 Node 16.17.1），因此：
 * - `target` 降到 `node16`，避免产出 Node 18+ 才认的语法；
 * - `__SM_LEGACY_ELECTRON__` 置真，让 `electron/compat/*` 与 tags 走回退分支；
 * - **undici 内联进产物**（现代版保持 external）：只有 Win7 分支会
 *   `require("undici")`，内联后主进程自包含，不必再往 electron-builder 的
 *   `files` 白名单里加 node_modules 条目。
 */
import { build } from "esbuild";
import { rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const watch = process.argv.includes("--watch");
/** Win7 兼容版构建（Electron 22 / Node 16）。 */
const win7 = process.argv.includes("--win7");

/** 产物目录按目标分开，避免两种产物互相覆盖。 */
const outdir = path.join(root, win7 ? "dist-electron-win7" : "dist-electron");

const shared = {
  bundle: true,
  platform: "node",
  // 与 Electron 内置的 Node 版本对齐（Electron 44 → Node 22；Win7 版 → Node 16）
  target: win7 ? "node16" : "node22",
  format: "cjs",
  outdir,
  outExtension: { ".js": ".cjs" },
  // CJS 里没有 import.meta：esbuild 会把 `import.meta` 替换成 {}（并报一条警告），
  // 于是 electron/tag-writer.ts 定位 wasm 时只能靠 `__filename`（CJS 产物本就有）。
  // 这里显式定义掉，既消掉警告，也让「CJS 走 __filename」成为确定行为；
  // 验证脚本打 ESM 时用的是另一套配置，import.meta.url 保持真实值。
  define: {
    "import.meta.url": "undefined",
    // 构建期开关：Electron 22 兼容分支。运行期嗅探不够可靠（Node 16 的差异
    // 不只在 fetch），编译期裁掉最干净，现代版产物里连分支代码都不会留。
    __SM_LEGACY_ELECTRON__: win7 ? "true" : "false",
  },
  // electron 由运行时提供，不能打进包。
  //
  // taglib-wasm 是 **ESM-only**，而这里打的是 CJS：必须保持 external，
  // 运行时由 `await import("taglib-wasm")` 加载（见 electron/tag-writer.ts）。
  // 一旦被 bundle 进来，它内部的 `import.meta.url` / `createRequire` 兜底路径
  // 就会被 esbuild 改写成 {}（实测），wasm 定位必挂。
  external: [
    "electron",
    "taglib-wasm",
    "taglib-wasm/simple",
    // 现代版保持 external：Electron 44 自带全局 fetch，走不到 require("undici")。
    // Win7 版内联（见文件头说明）。
    ...(win7 ? [] : ["undici"]),
  ],
  sourcemap: watch ? "inline" : false,
  minify: !watch,
  logLevel: "info",
};

const entries = ["electron/main.ts", "electron/preload.ts", "electron/webview-preload.ts"].map(
  (rel) => path.join(root, rel),
);

if (!watch) {
  rmSync(outdir, { recursive: true, force: true });
}

if (watch) {
  const { context } = await import("esbuild");
  const ctx = await context({ ...shared, entryPoints: entries });
  await ctx.watch();
  console.log("[build-electron] 监听模式已启动");
} else {
  await build({ ...shared, entryPoints: entries });
  console.log(
    `[build-electron] 构建完成 → ${path.relative(root, outdir)}/（${win7 ? "win7" : "modern"}）`,
  );
}
