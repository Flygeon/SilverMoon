/**
 * `virtual:sm-colormix-pairs` 的类型声明。
 *
 * 该虚拟模块由 `scripts/vite-plugin-colormix-fallback.mjs` 在构建期提供：
 * 插件扫描 `src/` 下全部 `.vue` / `.css`，收集实际用到的
 * (token, 百分数) 组合，运行期据此重算 `--sm-mix-*`。
 *
 * 现代构建（未开 `SM_COLORMIX_FALLBACK`）导出空数组，运行期直接 no-op。
 */
declare module "virtual:sm-colormix-pairs" {
  /** 一个需要运行期同步的 (token, 百分数列表)。 */
  interface ColorMixPair {
    /** 不含 `--` 前缀的 token 名（派生变量名中间那段） */
    name: string;
    /** 完整 CSS 变量名（含 `--`） */
    token: string;
    /** 该 token 上用到的百分数（已升序去重） */
    percents: number[];
  }

  export const COLOR_MIX_PAIRS: ColorMixPair[];
}
