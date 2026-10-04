import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import { fileURLToPath, URL } from "node:url";
import { readFileSync } from "node:fs";

/**
 * 应用版本号以构建期常量注入（`__APP_VERSION__`）。单一真源是
 * `backend/silvermoon.config.json`（主进程与后端都读它），
 * 前端通过同名常量取用，避免又多一处要同步的版本号。
 */
const appConfig = JSON.parse(
  readFileSync(fileURLToPath(new URL("./backend/silvermoon.config.json", import.meta.url)), "utf8"),
) as { version: string };

// https://vitejs.dev/config/
export default defineConfig(async () => ({
  plugins: [
    vue({
      template: {
        compilerOptions: {
          // m3e-* 是 @m3e/web 原生自定义元素，交给浏览器处理，不要当 Vue 组件解析
          isCustomElement: (tag) => tag.startsWith("m3e-"),
        },
      },
    }),
  ],
  define: {
    __APP_VERSION__: JSON.stringify(appConfig.version),
  },
  resolve: {
    alias: {
      // 渲染进程的全部原生能力都在 `src/ipc/` 下，经 `@/` 即可引用，
      // 因此除下面两条外不再需要额外的路径映射。
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      "@shared": fileURLToPath(new URL("./shared", import.meta.url)),
    },
  },
  // worker 一律用 ES module 格式。
  //
  // 默认的 `iife` 对含**代码分割**（动态 import）的 worker 直接报
  // `Invalid value "iife" ... not supported for code-splitting builds`。
  // 本仓库新加的 pdf.js 兼容 worker 需要在补 `Promise.withResolvers` 之后再
  // 动态 import 官方 worker（见 src/workers/pdfWorkerLegacy.ts），必然带动态
  // import；另两个 worker（wordAnalysis / autoMix）本来就用
  // `new Worker(..., { type: "module" })`，ES 格式才是正确对应。
  worker: {
    format: "es",
  },
  // Electron 渲染进程同样走本地 dev server；端口与 electron/config.ts 的
  // DEV_SERVER_URL 保持一致
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      // 后端与 Electron 主进程都不参与前端热更
      ignored: ["**/backend/**", "**/electron/**", "**/dist-electron/**"],
    },
  },
  build: {
    // 打包后由 app:// 协议从 dist/ 提供服务，绝对路径 `/assets/...` 可正常解析
    outDir: "dist",
    emptyOutDir: true,
    // 构建目标显式钉在 **Chrome 108**（= Electron 22 的 Chromium）。
    //
    // 默认值（chrome87/es2020）有两个问题：
    // 1. 不允许 top-level await，而 pdf.js 兼容 worker 需要它；
    // 2. 会把代码降级到 2020 语法，而实际宿主（Electron 44 → Chromium 132）
    //    远高于此，无谓地损失体积与性能。
    // 钉 108 后：现代版与 Win7 版共用同一份 dist，且不会用到 108 之后才有的特性
    // （如 `color-mix()`、`Promise.withResolvers` 由运行期 polyfill 兜底）。
    target: "chrome108",
    // pdf.js 的 wasm 与 worker 体积较大，阈值调到不会误报的档位
    chunkSizeWarningLimit: 4096,
    rollupOptions: {
      output: {
        // 只让 manualChunks **显式点名**的模块成块；Rollup 自行派生的公共块
        // （尤其是 CJS 互操作助手）一律回落到真正使用它的 chunk 里。
        //
        // 踩坑记录（首屏凭空多拉 416KB）：pako / qrcode 是 CJS，经
        // App.vue → player → netease/kugou 被**静态**拉进入口 chunk，它们需要 Rollup
        // 的 `interopDefault` 助手（几十字节）。不开这个开关时 Rollup 会把这个助手塞进
        // 它认为合适的**任意**命名块 —— 实测塞进了 amll-bg，于是入口 chunk 出现真静态
        // 依赖 `import{g as _S}from"./amll-bg-*.js"`，Vite 顺手在 index.html 加了
        // `<link rel="modulepreload" href=".../amll-bg-*.js">`，416KB 的 AMLL 包在首帧
        // 就被下载，「切到 AMLL 引擎才加载」彻底失效。
        // 开启后助手独立成 `_commonjsHelpers-*.js`（约 0.7KB），amll-bg 回到按需加载。
        onlyExplicitManualChunks: true,
        // 重依赖各自成块，配合动态 import 保证「进哪个页面才加载哪个块」：
        // amll-bg（AMLL core + @pixi/*，6MB+）只有选 AMLL 背景才会拉，
        // anime-player（artplayer + 弹幕插件）只有进番剧播放页才会拉。
        manualChunks(id) {
          if (!id.includes("node_modules")) return undefined;
          // CSS 让 Vite 自己分给动态 import 它的组件：样式若并进 amll-bg，
          // AMLL 的 style.css 会随该块一起被加载，「按需」失效。
          if (id.endsWith(".css")) return undefined;
          if (id.includes("@applemusic-like-lyrics") || /@pixi\//.test(id)) return "amll-bg";
          if (id.includes("artplayer")) return "anime-player";
          if (id.includes("pdfjs")) return "pdf-viewer";
          if (id.includes("epubjs")) return "epub-reader";
          if (id.includes("leafer")) return "drawing";
          return undefined;
        },
      },
    },
  },
}));
