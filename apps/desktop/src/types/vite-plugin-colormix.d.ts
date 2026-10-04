/**
 * `scripts/vite-plugin-colormix-fallback.mjs` 的类型声明。
 *
 * 该插件是纯 JS（.mjs），需要被 TS 测试 `colorMixParity.test.ts` 直接 import ——
 * 目的是让一致性测试跑**插件本体的真实实现**，而不是复刻一份换算逻辑
 * （复刻无法证明两边一致）。
 *
 * 这里只声明测试用到的那部分接口。
 */
declare module "*/vite-plugin-colormix-fallback.mjs" {
  /** 一次 `color-mix(...)` 被改写后的结果（Vite transform 返回值）。 */
  interface ColorMixTransformResult {
    code: string;
    map: null;
  }

  interface ColorMixFallbackOptions {
    /** 是否启用回退；缺省读 `process.env.SM_COLORMIX_FALLBACK === "1"` */
    enabled?: boolean;
    /** 工程根目录（用于定位 src/tokens/theme.css） */
    root?: string;
  }

  interface ColorMixFallbackPlugin {
    name: string;
    enforce: "pre";
    buildStart(): void;
    resolveId(id: string): string | null;
    load(id: string): string | null;
    transform(code: string, id: string): ColorMixTransformResult | null;
  }

  export function colorMixFallback(options?: ColorMixFallbackOptions): ColorMixFallbackPlugin;

  /** 由 (颜色操作数, 百分数) 生成派生变量名，运行期按同一规则读写。 */
  export function derivedVarName(operand: string, percent: number): string;
}
