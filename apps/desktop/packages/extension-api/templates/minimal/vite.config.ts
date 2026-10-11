import { defineConfig } from "vite";
import { silvermoonExtension } from "@silvermoon/extension-api/vite";

/**
 * 构建产物会直接落到扩展包约定的 `web/dist`（由 manifest.json 的 web.dist 决定，
 * 缺省也是 web/dist），并把扩展 id 注入为 `__EXT_ID__` 常量。
 */
export default defineConfig({
  plugins: [silvermoonExtension()],
  // 扩展 UI 只在扩展窗口里跑，target 可以跟着宿主 WebView 走
  build: {
    target: "es2021",
  },
});
