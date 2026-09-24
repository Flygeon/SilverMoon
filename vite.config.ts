import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import { fileURLToPath, URL } from "node:url";
import { readFileSync } from "node:fs";

const here = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));

/**
 * 应用版本号以构建期常量注入（`__APP_VERSION__`）。迁移后单一真源改为
 * `src-tauri/silvermoon.config.json`（Electron 主进程与 Rust 侧车都读它），
 * 这里保持同名常量，前端代码无需改动。
 */
const appConfig = JSON.parse(readFileSync(here("./src-tauri/silvermoon.config.json"), "utf8")) as {
  version: string;
};

/**
 * 把 `@tauri-apps/*` 全部指向本地 shim。
 *
 * 这是「前端业务源码零改动」的关键：`src/` 下 23 个文件里那些
 * `import { invoke } from "@tauri-apps/api/core"` 一行都不用动，
 * 由 alias 改接到 `src/shims/` 下的等价实现。
 *
 * 之所以逐条列出而不是用正则通配：路径映射同时要在 `tsconfig.json` 的
 * `paths` 里写一份（让 `vue-tsc` 也能按 shim 做类型检查），
 * 显式列表能保证两处永远一致、也便于审阅。
 */
const tauriShims: Record<string, string> = {
  "@tauri-apps/api/core": here("./src/shims/api/core.ts"),
  "@tauri-apps/api/event": here("./src/shims/api/event.ts"),
  "@tauri-apps/api/window": here("./src/shims/api/window.ts"),
  "@tauri-apps/api/webview": here("./src/shims/api/webview.ts"),
  "@tauri-apps/api/webviewWindow": here("./src/shims/api/webviewWindow.ts"),
  "@tauri-apps/api/dpi": here("./src/shims/api/dpi.ts"),
  "@tauri-apps/api/path": here("./src/shims/api/path.ts"),
  "@tauri-apps/api/app": here("./src/shims/api/app.ts"),
  "@tauri-apps/plugin-store": here("./src/shims/plugin-store.ts"),
  "@tauri-apps/plugin-dialog": here("./src/shims/plugin-dialog.ts"),
  "@tauri-apps/plugin-fs": here("./src/shims/plugin-fs.ts"),
  "@tauri-apps/plugin-opener": here("./src/shims/plugin-opener.ts"),
  "@tauri-apps/plugin-http": here("./src/shims/plugin-http.ts"),
};

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
      "@": here("./src"),
      "@shared": here("./shared"),
      ...tauriShims,
    },
  },
  // Electron 渲染进程同样走本地 dev server；端口与 electron/config.ts 的
  // DEV_SERVER_URL 保持一致
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      // Rust 侧车与 Electron 主进程都不参与前端热更
      ignored: ["**/src-tauri/**", "**/electron/**", "**/dist-electron/**"],
    },
  },
  build: {
    // 打包后由 app:// 协议从 dist/ 提供服务，绝对路径 `/assets/...` 可正常解析
    outDir: "dist",
    emptyOutDir: true,
  },
}));
