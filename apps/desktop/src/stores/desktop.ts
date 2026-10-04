/**
 * 桌面环境集成 store：壁纸 / 常亮锁（防休眠）/ 系统通知 / 系统强调色。
 *
 * 全部经 UDA（UniDesktop API）走 Rust sidecar 实现，原因见
 * `backend/src/commands/desktop.rs` 的模块文档：同一项能力在 Linux 上按桌面
 * 环境分裂成 gsettings / plasmashell / hyprpaper / swww / feh，Windows 上又是
 * 另一套 Win32 / WinRT，UDA 用一套能力驱动的 trait 把它们统一。
 *
 * 三条使用约定：
 * 1. **调用前分流**：入口显隐看 `caps`，不要调用了再 catch。
 * 2. **失败静默**：通知 / 常亮锁是锦上添花，平台不支持或守护进程缺失时
 *    不能打断主流程（扫描、播放），一律吞掉错误。
 * 3. **常亮锁按「理由」登记**：Windows 侧是进程级开关、Linux 侧是 D-Bus
 *    cookie，同时只持有一把锁，由理由集合的 emptiness 决定取/放。
 */

import { defineStore } from "pinia";
import { computed, ref } from "vue";

import { capabilities, isDesktop } from "@/capabilities";
import type { DesktopCaps, Rgba, WakeLockKind, WallpaperMode } from "@shared/types";

/** 常亮锁的「理由」常量：避免各处硬编码字符串导致登记/撤销对不上。 */
export const WAKE_REASON = {
  /** 媒体库扫描 */
  scan: "library-scan",
  /** 音视频播放 */
  playback: "playback",
  /** 下载 / 转码等长任务 */
  transfer: "transfer",
} as const;

export type WakeReason = (typeof WAKE_REASON)[keyof typeof WAKE_REASON];

/** 浏览器预览（无 UDA 后端）时的能力表：全不可用。 */
const NO_CAPS: DesktopCaps = {
  platform: "unsupported",
  supported: false,
  setWallpaper: false,
  getWallpaper: false,
  sendNotification: false,
  wakeLock: false,
  readAccentColor: false,
};

export const useDesktopStore = defineStore("desktop", () => {
  /** null = 尚未探测（浏览器预览下探测完也是 NO_CAPS） */
  const caps = ref<DesktopCaps | null>(null);
  /** 系统强调色；平台无强调色时为 null，这是正常状态 */
  const accent = ref<Rgba | null>(null);
  /** 上一次壁纸设置的错误文案（供 UI 提示） */
  const lastError = ref<string | null>(null);

  const canWallpaper = computed(() => caps.value?.setWallpaper ?? false);
  const canNotify = computed(() => caps.value?.sendNotification ?? false);
  const canWakeLock = computed(() => caps.value?.wakeLock ?? false);
  const canAccent = computed(() => caps.value?.readAccentColor ?? false);

  /** 启动时探测一次能力与系统强调色。失败不影响应用其它部分。 */
  async function init(): Promise<void> {
    if (!isDesktop) {
      caps.value = NO_CAPS;
      return;
    }
    try {
      const probed = await capabilities.desktopCapabilities();
      caps.value = probed ?? NO_CAPS;
    } catch {
      caps.value = NO_CAPS;
    }
    if (caps.value.readAccentColor) {
      try {
        accent.value = await capabilities.systemAccentColor();
      } catch {
        accent.value = null;
      }
    }
  }

  /**
   * 发系统通知。平台不支持、守护进程缺失、发送失败都**静默返回 false**，
   * 绝不抛错打断调用方。
   */
  async function notify(
    title: string,
    body?: string,
    opts?: { icon?: string; urgency?: 0 | 1 | 2 },
  ): Promise<boolean> {
    if (!canNotify.value) return false;
    try {
      await capabilities.desktopNotify(title, body ?? "", opts?.icon, opts?.urgency);
      return true;
    } catch {
      return false;
    }
  }

  /** 登记一个保持唤醒的理由。返回是否真的持有了锁。 */
  async function keepAwake(reason: WakeReason, kind: WakeLockKind = "system"): Promise<boolean> {
    if (!canWakeLock.value) return false;
    try {
      return await capabilities.acquireWakeLock(reason, kind);
    } catch {
      return false;
    }
  }

  /** 撤销一个保持唤醒的理由（集合清空才真正释放）。 */
  async function allowSleep(reason?: WakeReason): Promise<void> {
    if (!canWakeLock.value) return;
    try {
      await capabilities.releaseWakeLock(reason);
    } catch {
      /* 锁本来就没持有，或后端已不可用 —— 无需处理 */
    }
  }

  /** 设为系统壁纸。返回是否成功；失败时错误信息写进 `lastError`。 */
  async function setWallpaper(
    path: string,
    mode: WallpaperMode = "fill",
    dark = false,
  ): Promise<boolean> {
    if (!canWallpaper.value) {
      lastError.value = "当前平台不支持设置壁纸";
      return false;
    }
    try {
      await capabilities.setWallpaper(path, mode, dark);
      lastError.value = null;
      return true;
    } catch (e) {
      lastError.value = String((e as Error)?.message ?? e);
      return false;
    }
  }

  return {
    caps,
    accent,
    lastError,
    canWallpaper,
    canNotify,
    canWakeLock,
    canAccent,
    init,
    notify,
    keepAwake,
    allowSleep,
    setWallpaper,
  };
});
