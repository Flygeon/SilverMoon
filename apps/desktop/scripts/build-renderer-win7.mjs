/**
 * Win7 版渲染层构建：打开 color-mix 回退开关后跑 `vite build`。
 *
 * ## 为什么用脚本而不是 `SM_COLORMIX_FALLBACK=1 vite build`
 *
 * 后者是 POSIX shell 语法，在 Windows 的 cmd/PowerShell 下不成立 ——
 * 而 Win7 版的构建恰恰最可能在 Windows runner 上做。这里直接设
 * `process.env` 再以编程方式调 Vite，两个平台行为一致，也不用引入 cross-env。
 *
 * 产物与普通 `vite build` 同目录（`dist/`），只是 CSS 里的 color-mix 被
 * 预先换算成 rgba（见 scripts/vite-plugin-colormix-fallback.mjs）。
 */
import { build } from "vite";

process.env.SM_COLORMIX_FALLBACK = "1";

await build({ mode: "production" });
console.log("[build-renderer-win7] 完成（已启用 color-mix 回退）");
