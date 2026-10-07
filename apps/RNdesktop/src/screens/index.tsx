import React from 'react';
import { PlaceholderScreen } from '../components';
import type { RouteDef, RouteId } from '../navigation/routes';

/**
 * 路由 → 界面 的**唯一注册点**。
 *
 * 骨架阶段所有路由都指向占位屏。逐个实现功能时，只要在这里把对应条目换成
 * 真实界面组件即可 —— 侧栏 / 路由层不需要任何改动。
 */
export type ScreenComponent = React.ComponentType<{ route: RouteDef }>;

const SCREENS: Record<RouteId, ScreenComponent> = {
  gallery: PlaceholderScreen,
  video: PlaceholderScreen,
  music: PlaceholderScreen,
  library: PlaceholderScreen,
  writer: PlaceholderScreen,
  online: PlaceholderScreen,
  extensions: PlaceholderScreen,
  settings: PlaceholderScreen,
};

export function screenFor(id: RouteId): ScreenComponent {
  return SCREENS[id] ?? PlaceholderScreen;
}
