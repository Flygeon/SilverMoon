/**
 * 单元测试配置（vitest）。
 *
 * 为什么不直接复用 vite.config.ts：那份导出的是**回调**，`mergeConfig` 不接受回调，
 * 所以这里重写一份最小配置 —— 只保留测试真正需要的三件事：
 * Vue 插件、路径别名、以及下面那条 MCU 补丁。
 *
 * ### 唯一的「非标准」配置：MCU 打成 inline
 *
 * `@material/material-color-utilities@0.4.0` 的 `dynamiccolor/color_spec_2025.js`
 * 里有一行缺 `.js` 扩展名的相对导入：
 *
 * ```js
 * import { DynamicColor, extendSpecVersion } from './dynamic_color'   // 应为 './dynamic_color.js'
 * ```
 *
 * Vite / esbuild 打包时会自动补扩展名，但 Node 的 ESM 解析器不会 —— vitest 默认
 * 把 node_modules 丢给 Node 解析，于是任何 `import ... from "@shared/m3-theme"`
 * 的测试都会直接报 `Cannot find module .../dynamic_color`。
 * `inline` 让这段代码走 Vite 的解析器，问题即消失。上游修好后删掉即可。
 */
import { fileURLToPath, URL } from "node:url";
import { readFileSync } from "node:fs";
import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vitest/config";

/**
 * 与 vite.config.ts 保持一致：`__APP_VERSION__` 是构建期注入的常量，
 * 源码里 `stores/skins.ts` 与 `SettingsView.vue` 直接引用它。
 * 测试不注入就会在 import 阶段报 `__APP_VERSION__ is not defined`
 * （目前没有测试直接 import 那两个模块，但测试依赖链一变就会踩到）。
 */
const appVersion = (
  JSON.parse(
    readFileSync(
      // 与 vite.config.ts 同一个真源。曾误用 src-tauri 的遗留副本。
      fileURLToPath(new URL("./backend/silvermoon.config.json", import.meta.url)),
      "utf8",
    ),
  ) as { version: string }
).version;

export default defineConfig({
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
  test: {
    server: {
      deps: {
        // 见文件头：让 Vite 解析 MCU 里那条缺扩展名的相对导入
        inline: ["@material/material-color-utilities"],
      },
    },
  },
});
