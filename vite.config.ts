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
  },
}));
