import React, { createContext, useContext, useMemo } from 'react';
import { useColorScheme } from 'react-native';
import { resolveTheme, type ColorScheme, type Theme, type ThemeMode } from './theme';

interface ThemeContextValue {
  theme: Theme;
  /** 用户选择的模式。 */
  mode: ThemeMode;
  /** 切换模式（设置页将来接持久化存储）。 */
  setMode: (mode: ThemeMode) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export interface ThemeProviderProps {
  children: React.ReactNode;
  /** 受控模式；不传则内部维护（骨架阶段默认跟随系统）。 */
  mode?: ThemeMode;
  onModeChange?: (mode: ThemeMode) => void;
}

/**
 * 主题提供者。骨架阶段用 React state 持有模式，**不落盘** ——
 * 持久化留给 `store:kv` 宿主通道，避免这里先写一套以后要拆掉的实现。
 */
export function ThemeProvider({
  children,
  mode: controlledMode,
  onModeChange,
}: ThemeProviderProps): React.JSX.Element {
  const systemScheme = useColorScheme() as ColorScheme | null | undefined;
  const [innerMode, setInnerMode] = React.useState<ThemeMode>('system');
  const mode = controlledMode ?? innerMode;

  const value = useMemo<ThemeContextValue>(() => {
    return {
      theme: resolveTheme(mode, systemScheme),
      mode,
      setMode: (next: ThemeMode) => {
        if (controlledMode === undefined) setInnerMode(next);
        onModeChange?.(next);
      },
    };
  }, [mode, systemScheme, controlledMode, onModeChange]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

/** 读取当前主题。必须在 ThemeProvider 内使用。 */
export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) {
    throw new Error('useTheme 必须在 <ThemeProvider> 内使用');
  }
  return ctx;
}

/** 只取颜色表的便捷钩子。 */
export function useColors() {
  return useTheme().theme.colors;
}
