import React, { createContext, useCallback, useContext, useMemo, useState } from 'react';
import { DEFAULT_ROUTE, routeById, type RouteDef, type RouteId } from './routes';

/**
 * 极简路由。
 *
 * **为什么不用 React Navigation**：桌面端的导航是「侧栏常驻 + 内容区切换」，
 * 没有手势返回、没有页面栈、没有转场动画，装 React Navigation 只会带进
 * react-native-screens / gesture-handler 两个原生依赖 —— 骨架阶段没必要为
 * 用不到的能力承担原生编译面。
 *
 * 将来需要「详情页叠在列表页之上」时，再把它换成真正的路由库，
 * 上层只依赖这里的 `useNavigation()`，替换面被限制在单个文件内。
 */
interface NavigationContextValue {
  /** 当前路由。 */
  current: RouteDef;
  /** 访问过的路由序列（末位即当前），供后退使用。 */
  history: RouteId[];
  navigate: (id: RouteId) => void;
  goBack: () => void;
  canGoBack: boolean;
}

const NavigationContext = createContext<NavigationContextValue | null>(null);

export interface NavigationProviderProps {
  children: React.ReactNode;
  initialRoute?: RouteId;
}

export function NavigationProvider({
  children,
  initialRoute = DEFAULT_ROUTE,
}: NavigationProviderProps): React.JSX.Element {
  // 当前路由单独持一份，不去索引 history 的末位：
  // tsconfig 开了 noUncheckedIndexedAccess，索引访问的类型是 `RouteId | undefined`，
  // 让「当前路由」依赖数组下标会把这个不确定性强加给所有调用方。
  const [currentId, setCurrentId] = useState<RouteId>(initialRoute);
  const [history, setHistory] = useState<RouteId[]>([initialRoute]);

  const navigate = useCallback((id: RouteId) => {
    setCurrentId(prev => {
      if (prev === id) return prev;
      setHistory(stack => [...stack, id]);
      return id;
    });
  }, []);

  const goBack = useCallback(() => {
    setHistory(stack => {
      if (stack.length <= 1) return stack;
      const next = stack.slice(0, -1);
      const last = next[next.length - 1];
      if (last !== undefined) setCurrentId(last);
      return next;
    });
  }, []);

  const value = useMemo<NavigationContextValue>(
    () => ({
      current: routeById(currentId),
      history,
      navigate,
      goBack,
      canGoBack: history.length > 1,
    }),
    [currentId, history, navigate, goBack],
  );

  return <NavigationContext.Provider value={value}>{children}</NavigationContext.Provider>;
}

export function useNavigation(): NavigationContextValue {
  const ctx = useContext(NavigationContext);
  if (!ctx) throw new Error('useNavigation 必须在 <NavigationProvider> 内使用');
  return ctx;
}
