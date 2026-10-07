/**
 * 设计令牌（Design Tokens）。
 *
 * 命名对齐 **Material Design 3** 的角色化色彩（`primary` / `surface` / `onSurface`
 * / `outline` …），因为现有桌面端就是 MD3 + Monet 动态取色；React Native 端沿用同一套
 * 角色名，将来把 Rust 侧算好的配色直接灌进来即可，不需要在界面层做映射。
 *
 * 数值取向：桌面端字号偏小、间距偏紧（鼠标精度高、信息密度大），
 * 与移动端触控尺寸的取值刻意不同。
 */

/** 颜色角色。亮 / 暗两套主题的键完全一致。 */
export interface ColorTokens {
  /** 主色及其上的前景色（按钮 / 选中态）。 */
  primary: string;
  onPrimary: string;
  primaryContainer: string;
  onPrimaryContainer: string;
  /** 次级强调色（次要按钮 / 标签）。 */
  secondary: string;
  onSecondary: string;
  secondaryContainer: string;
  onSecondaryContainer: string;
  /** 错误态。 */
  error: string;
  onError: string;
  errorContainer: string;
  onErrorContainer: string;
  /** 背景与表面层级：surface 最低，surfaceContainerHighest 最高。 */
  background: string;
  onBackground: string;
  surface: string;
  onSurface: string;
  surfaceVariant: string;
  onSurfaceVariant: string;
  surfaceContainerLowest: string;
  surfaceContainerLow: string;
  surfaceContainer: string;
  surfaceContainerHigh: string;
  surfaceContainerHighest: string;
  /** 描边 / 分隔线。 */
  outline: string;
  outlineVariant: string;
  /** 反色表面（工具提示、浮层）。 */
  inverseSurface: string;
  onInverseSurface: string;
  /** 滚动条 / 禁用态。 */
  disabled: string;
  onDisabled: string;
  /** 语义化状态色（连接指示灯、错误提示）。 */
  success: string;
  warning: string;
}

export const lightColors: ColorTokens = {
  primary: '#4C5BD4',
  onPrimary: '#FFFFFF',
  primaryContainer: '#DFE0FF',
  onPrimaryContainer: '#00105C',
  secondary: '#5C5D72',
  onSecondary: '#FFFFFF',
  secondaryContainer: '#E1E0F9',
  onSecondaryContainer: '#191A2C',
  error: '#BA1A1A',
  onError: '#FFFFFF',
  errorContainer: '#FFDAD6',
  onErrorContainer: '#410002',
  background: '#FBF8FF',
  onBackground: '#1B1B21',
  surface: '#FBF8FF',
  onSurface: '#1B1B21',
  surfaceVariant: '#E3E1EC',
  onSurfaceVariant: '#46464F',
  surfaceContainerLowest: '#FFFFFF',
  surfaceContainerLow: '#F5F2FA',
  surfaceContainer: '#EFEDF4',
  surfaceContainerHigh: '#E9E7EF',
  surfaceContainerHighest: '#E4E1E9',
  outline: '#777680',
  outlineVariant: '#C7C5D0',
  inverseSurface: '#303036',
  onInverseSurface: '#F3EFF7',
  disabled: '#C7C5D0',
  onDisabled: '#777680',
  success: '#1B6B3A',
  warning: '#8A5300',
};

export const darkColors: ColorTokens = {
  primary: '#BEC2FF',
  onPrimary: '#1B2678',
  primaryContainer: '#333D8F',
  onPrimaryContainer: '#DFE0FF',
  secondary: '#C5C4DD',
  onSecondary: '#2E2F42',
  secondaryContainer: '#444559',
  onSecondaryContainer: '#E1E0F9',
  error: '#FFB4AB',
  onError: '#690005',
  errorContainer: '#93000A',
  onErrorContainer: '#FFDAD6',
  background: '#131318',
  onBackground: '#E4E1E9',
  surface: '#131318',
  onSurface: '#E4E1E9',
  surfaceVariant: '#46464F',
  onSurfaceVariant: '#C7C5D0',
  surfaceContainerLowest: '#0E0E13',
  surfaceContainerLow: '#1B1B21',
  surfaceContainer: '#1F1F25',
  surfaceContainerHigh: '#2A2930',
  surfaceContainerHighest: '#35343B',
  outline: '#918F9A',
  outlineVariant: '#46464F',
  inverseSurface: '#E4E1E9',
  onInverseSurface: '#303036',
  disabled: '#46464F',
  onDisabled: '#777680',
  success: '#7EDBA0',
  warning: '#FFB95C',
};

/** 间距阶梯（4 的倍数，桌面端偏紧）。 */
export const spacing = {
  none: 0,
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
} as const;

/** 圆角。 */
export const radius = {
  none: 0,
  sm: 4,
  md: 8,
  lg: 12,
  xl: 16,
  full: 999,
} as const;

/** 字号与行高。桌面端基准 13，正文 14。 */
export const typography = {
  display: { fontSize: 32, lineHeight: 40, fontWeight: '600' as const },
  headline: { fontSize: 22, lineHeight: 30, fontWeight: '600' as const },
  title: { fontSize: 16, lineHeight: 24, fontWeight: '600' as const },
  body: { fontSize: 14, lineHeight: 22, fontWeight: '400' as const },
  label: { fontSize: 13, lineHeight: 18, fontWeight: '500' as const },
  caption: { fontSize: 11, lineHeight: 16, fontWeight: '400' as const },
} as const;

/** 桌面端固定尺寸（侧栏 / 标题栏）。 */
export const metrics = {
  titleBarHeight: 40,
  sidebarWidth: 220,
  sidebarCollapsedWidth: 56,
  toolbarHeight: 44,
  statusBarHeight: 26,
} as const;

/** 动效时长（毫秒），与 MD3 的时长档位对齐。 */
export const motion = {
  short: 120,
  medium: 220,
  long: 400,
} as const;
