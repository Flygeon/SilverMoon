/**
 * 全局右键菜单状态（Material Design 3）。
 * ContextMenu.vue 读取此状态渲染，任意组件调用 openContextMenu 触发。
 */
import { reactive } from "vue";

export interface MenuItem {
  id: string;
  label: string;
  icon?: string;
  danger?: boolean;
  disabled?: boolean;
  /**
   * 子菜单项。有值时该项渲染成「父项 + 右侧箭头」，悬停 / 聚焦展开子菜单。
   *
   * 子项点击回调仍走同一个 onSelect，id 由调用方自己保证与顶层项不冲突
   * （约定用 `父id:子id` 形式，例如 `wallpaper:crop`）。
   */
  children?: MenuItem[];
}

interface ContextMenuState {
  x: number;
  y: number;
  items: MenuItem[];
  visible: boolean;
  onSelect: ((id: string) => void) | null;
}

const state = reactive<ContextMenuState>({
  x: 0,
  y: 0,
  items: [],
  visible: false,
  onSelect: null,
});

/** 在右键事件位置弹出菜单 */
export function openContextMenu(
  e: MouseEvent,
  items: MenuItem[],
  onSelect: (id: string) => void,
): void {
  e.preventDefault();
  e.stopPropagation();
  state.x = e.clientX;
  state.y = e.clientY;
  state.items = items;
  state.onSelect = onSelect;
  state.visible = true;
}

export function closeContextMenu(): void {
  state.visible = false;
  state.onSelect = null;
}

export function useContextMenu(): ContextMenuState {
  return state;
}
