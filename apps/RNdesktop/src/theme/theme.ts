import { darkColors, lightColors, type ColorTokens } from './tokens';

/** 主题模式：跟随系统 / 强制亮 / 强制暗。 */
export type ThemeMode = 'system' | 'light' | 'dark';

/** 解析后的主题。 */
export type ColorScheme = 'light' | 'dark';

export interface Theme {
  mode: ThemeMode;
  scheme: ColorScheme;
  colors: ColorTokens;
}

/** 根据模式与系统配色解析出实际生效的主题。 */
export function resolveTheme(mode: ThemeMode, systemScheme: ColorScheme | null | undefined): Theme {
  const scheme: ColorScheme = mode === 'system' ? systemScheme ?? 'light' : mode;
  return {
    mode,
    scheme,
    colors: scheme === 'dark' ? darkColors : lightColors,
  };
}

/** 不带 React 的默认主题，供非组件代码（测试、纯函数）使用。 */
export const defaultTheme: Theme = resolveTheme('system', 'light');
