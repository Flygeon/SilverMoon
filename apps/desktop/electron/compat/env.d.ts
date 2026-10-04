/**
 * 构建期注入的常量声明。
 *
 * 真源是 `scripts/build-electron.mjs` 的 `define`：
 * - `false` → 现代构建（Electron 44 / Node 22）；
 * - `true`  → Win7 兼容构建（Electron 22 / Node 16）。
 *
 * 用编译期常量而不是运行期嗅探：现代产物里连兼容分支的代码都不会被保留。
 */
declare const __SM_LEGACY_ELECTRON__: boolean;
