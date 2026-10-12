/**
 * 系统托盘。
 *
 * 菜单结构完全由 后端进程给出（`tray.rs` 构造好 `Menu`/`MenuItem`/`Submenu`
 * 再经宿主操作 `tray.create` 送过来），这里只负责把它翻译成 Electron 的原生菜单、
 * 并把点击事件回抛给 Rust。
 *
 * 之所以不把托盘逻辑搬到 Electron：扩展贡献的托盘项来自 Rust 的扩展框架
 * （`extension::tray_menu_items`），且点击后要调 `ext_invoke`，留在 Rust 侧
 * 才能让 `tray.rs` 保持零改动。
 */
import { Menu, Tray, nativeImage } from "electron";

import { iconPath } from "./config";
import { log } from "./log";

/** Rust 侧送来的菜单描述。 */
type MenuNode =
  | { type: "separator" }
  | { type: "normal"; id: string; text: string; enabled: boolean; accelerator?: string }
  | { type: "submenu"; text: string; enabled: boolean; items: MenuNode[] };

let tray: Tray | null = null;

/** 事件回调（由 `main.ts` 注入，实际是转发到侧车的 `/_host`）。 */
type Callback = (payload: Record<string, unknown>) => Promise<unknown>;

let callback: Callback | null = null;

export function setTrayCallback(cb: Callback): void {
  callback = cb;
}

/** 创建托盘。 */
export function createTray(payload: {
  id?: string;
  iconPath?: string;
  menu?: MenuNode[] | null;
  tooltip?: string;
  showMenuOnLeftClick?: boolean;
}): void {
  if (tray) {
    // 重建（例如扩展装载后菜单变了）
    tray.destroy();
    tray = null;
  }

  const image = loadIcon(payload.iconPath);
  tray = new Tray(image);
  tray.setToolTip(payload.tooltip ?? "SilverMoon");

  const menu = buildMenu(payload.menu ?? []);
  if (menu) tray.setContextMenu(menu);

  // 左键点击只触发事件、不弹菜单（右键才弹），与托盘交互习惯一致
  tray.on("click", () => {
    void callback?.({ kind: "tray-click", button: "left", state: "up" });
  });
  tray.on("right-click", () => {
    void callback?.({ kind: "tray-click", button: "right", state: "up" });
  });

  log.info("托盘已创建");
}

/**
 * 设置托盘可见性。
 *
 * Electron 的托盘图标没有「隐藏但保留」的 API（只有创建 / `destroy()`），
 * 而业务侧唯一的调用是 `tray.set_visible(true)`，语义上本就等价于「常驻」，
 * 因此这里保持无操作。
 */
export function setTrayVisible(visible: boolean): void {
  log.info(`托盘可见性请求：${visible}（托盘在 Electron 下常驻，忽略）`);
}

function loadIcon(explicit?: string): Electron.NativeImage {
  const candidates = [explicit, iconPath()].filter(Boolean) as string[];
  for (const file of candidates) {
    try {
      const image = nativeImage.createFromPath(file);
      if (!image.isEmpty()) return image.resize({ width: 16, height: 16 });
    } catch {
      /* 换下一个候选 */
    }
  }
  // 没有图标文件时用 1x1 透明图占位，避免直接抛错导致托盘整体不可用
  log.warn("未找到托盘图标，使用空白占位图");
  return nativeImage.createEmpty();
}

function buildMenu(nodes: MenuNode[]): Menu | null {
  if (!nodes.length) return null;
  const template: Electron.MenuItemConstructorOptions[] = nodes.map((node) => {
    if (node.type === "separator") return { type: "separator" };
    if (node.type === "submenu") {
      return {
        label: node.text,
        enabled: node.enabled,
        submenu: buildMenu(node.items ?? []) ?? [],
      };
    }
    return {
      label: node.text,
      enabled: node.enabled,
      accelerator: node.accelerator,
      click: () => {
        void callback?.({ kind: "tray-menu", id: node.id });
      },
    };
  });
  return Menu.buildFromTemplate(template);
}

/** 退出前销毁托盘，避免残留图标。 */
export function destroyTray(): void {
  tray?.destroy();
  tray = null;
}
