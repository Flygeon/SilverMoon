import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import { fileURLToPath, URL } from "node:url";
import { readFileSync } from "node:fs";

/**
 * 移动端（Flutter WebView）构建配置。
 *
 * 与桌面 vite.config.ts 的差异只有三点：
 * 1. base 用相对路径 —— 页面从 WebView 的 asset 自定义 scheme 加载，绝对路径 /assets 会 404
 * 2. 入口是 mobile.html，输出到 dist-mobile
 * 3. target 提到 es2020 并对齐 Android WebView / iOS WKWebView 的能力
 */
const appConfig = JSON.parse(
  readFileSync(fileURLToPath(new URL("./backend/silvermoon.config.json", import.meta.url)), "utf8"),
) as { version: string };

export default defineConfig({
  base: "./",
  plugins: [
    vue({
      template: {
        compilerOptions: {
          isCustomElement: (tag) => tag.startsWith("m3e-"),
        },
      },
    }),
  ],
  define: {
    __APP_VERSION__: JSON.stringify(appConfig.version),
  },
  resolve: {
    alias: [
      // 必须在 "@" 之前：切断 stores/library.ts 里那条动态 pdf import，
      // 否则 pdfjs + 2.2MB pdf.worker 会白白进包（音乐路径用不到）
      {
        find: /^@\/utils\/pdf$/,
        replacement: fileURLToPath(new URL("./src/mobile/stub-pdf.ts", import.meta.url)),
      },
      { find: "@shared", replacement: fileURLToPath(new URL("./shared", import.meta.url)) },
      { find: "@", replacement: fileURLToPath(new URL("./src", import.meta.url)) },
    ],
  },
  build: {
    outDir: "dist-mobile",
    emptyOutDir: true,
    target: "es2020",
    assetsInlineLimit: 4096,
    chunkSizeWarningLimit: 4096,
    // 产物必须**扁平**放在 dist-mobile 根下，不能有 assets/ 子目录。
    //
    // Flutter 的 pubspec assets 声明只收目录的**直属文件，不递归子目录**
    // （flutter_tools 的 _parseAssets 用 listSync(recursive: false)）。
    // 默认 assetsDir 是 "assets"，于是 mobile.html 进了包、
    // assets/webapp/assets/*.js 全部漏掉 —— 页面加载得出来，
    // <script src="./assets/mobile-xxx.js"> 却 404，表现为整页黑屏。
    assetsDir: ".",
    rollupOptions: {
      input: fileURLToPath(new URL("./mobile.html", import.meta.url)),
    },
  },
});
