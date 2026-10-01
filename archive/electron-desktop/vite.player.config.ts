import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import { fileURLToPath, URL } from "node:url";
import { readFileSync } from "node:fs";

/**
 * 播放器入口（player.html）的独立构建配置。
 *
 * 与 vite.config.ts 的差异仅在 build 段：产物落到 player-dist、资源走相对路径、
 * 只打 player.html 一个入口（绝不把 index.html 一起打进来）。
 * alias / 插件 / define / server 与主配置保持一致，保证同一份 Vue 源码在
 * 两个入口下编译结果等价。
 */

/**
 * 版本号单一真源，同 vite.config.ts（供 __APP_VERSION__ 定义）。
 *
 * ⚠️ 被迫偏离 vite.config.ts 的一处：归档里 `backend/` 目录已随 Rust 侧车迁出
 * （现址 apps/desktop/backend），照抄原路径会直接 ENOENT、构建连配置都加载不了。
 * 这里按「归档内 → 仓库现址」顺序探测，都缺失时退回 0.0.0 并告警。
 * 该常量只被 stores/skins.ts 的皮肤 schema 版本判断使用，不影响播放器链路。
 */
function readAppVersion(): string {
  const candidates = [
    new URL("./backend/silvermoon.config.json", import.meta.url),
    new URL("../../apps/desktop/backend/silvermoon.config.json", import.meta.url),
  ];
  for (const url of candidates) {
    try {
      const cfg = JSON.parse(readFileSync(fileURLToPath(url), "utf8")) as { version?: string };
      if (cfg.version) return cfg.version;
    } catch {
      /* 候选不存在则试下一个 */
    }
  }
  console.warn("[vite.player] silvermoon.config.json 未找到，__APP_VERSION__ 退回 0.0.0");
  return "0.0.0";
}

const appVersion = readAppVersion();

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
    __APP_VERSION__: JSON.stringify(appVersion),
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      "@shared": fileURLToPath(new URL("./shared", import.meta.url)),
    },
  },
  // 产物经 loopback（http://127.0.0.1:<port>/player.html）伺服，路径不固定，
  // 一律用相对路径引用资源。
  base: "./",
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      ignored: ["**/backend/**", "**/electron/**", "**/dist-electron/**"],
    },
  },
  build: {
    outDir: "player-dist",
    emptyOutDir: true,
    rollupOptions: {
      // 只此一个入口；不要在这里加 index.html
      input: fileURLToPath(new URL("./player.html", import.meta.url)),
      output: {
        manualChunks(id) {
          if (!id.includes("node_modules")) return undefined;
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
