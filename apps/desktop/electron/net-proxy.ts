/**
 * 全局网络代理的应用层（设置 → 网络）。
 *
 * ## 为什么需要它
 *
 * 应用里有两条互不相通的网络栈：
 * 1. **Chromium**（`<img>`、`<video>`、webview、`net.fetch`）—— 受
 *    `session.setProxy` 控制；
 * 2. **Node/undici 的全局 `fetch`**（宿主 `http` 通道原来的实现）—— **不读**
 *    Chromium 的代理配置，也不读 Windows 系统代理。
 *
 * 用户开着系统代理却看到「番剧页 / Bangumi 超时」，根因就在这里：抓取走的是
 * Node `fetch`，代理设置对它无效。现在宿主通道改用 `net.fetch`，并由本模块
 * 统一把「系统 / 自定义 / 直连」应用到 session。
 *
 * Rust 侧（番剧抓取）有独立的一份配置，见 `backend/src/net_proxy.rs`。
 */
import { session } from "electron";

import { log } from "./log";

export type NetworkProxyMode = "system" | "custom" | "none";

export interface NetworkProxyConfig {
  mode: NetworkProxyMode;
  /** 仅 custom 模式使用，如 `http://127.0.0.1:7890` / `socks5://127.0.0.1:7891` */
  url: string;
}

/** 设置里存下来的原始值 → 合法配置；非法值一律退回系统代理。 */
export function normalizeProxyConfig(mode: unknown, url: unknown): NetworkProxyConfig {
  const m = typeof mode === "string" ? mode : "system";
  const u = typeof url === "string" ? url.trim() : "";
  if (m === "none") return { mode: "none", url: "" };
  if (m === "custom") return u ? { mode: "custom", url: u } : { mode: "system", url: "" };
  return { mode: "system", url: "" };
}

/**
 * 用户填的代理地址 → Chromium 的 `proxyRules`。
 *
 * Chromium 的规则串语法是 `scheme=host:port;scheme=host:port`；也接受单个
 * `host:port`（对所有协议生效）。这里做了几种常见写法的归一：
 * - `http://127.0.0.1:7890` → `http=127.0.0.1:7890;https=127.0.0.1:7890`
 * - `socks5://127.0.0.1:7891` → `socks5=127.0.0.1:7891`
 * - `127.0.0.1:7890` → `http=...;https=...`
 * - 已经是 `http=...;https=...` 的规则串原样保留。
 */
export function toProxyRules(raw: string): string {
  const value = raw.trim();
  if (!value) return "";
  // 已经是规则串（含 `=`）：原样交给 Chromium
  if (value.includes("=")) return value;

  const match = /^(https?|socks5|socks4):\/\/([^/]+)/i.exec(value);
  if (match) {
    const scheme = match[1].toLowerCase();
    const host = match[2];
    if (scheme === "socks5" || scheme === "socks4") return `${scheme}=${host}`;
    // HTTP 代理同时用于 http 与 https 请求（CONNECT 隧道）
    return `http=${host};https=${host}`;
  }

  // 只写了 host:port：按 HTTP 代理处理
  const host = value.replace(/^\/+/, "").replace(/\/+$/, "");
  if (!host) return "";
  return `http=${host};https=${host}`;
}

/**
 * 应用代理配置到默认 session，并断开已建立的长连接。
 *
 * 只改配置不断开连接的话，已经复用的 CDN 连接仍然走旧路径；用户切换代理后
 * 会看到「设置改了但请求还是旧的」。
 */
export async function applyNetworkProxy(config: NetworkProxyConfig): Promise<void> {
  const ses = session.defaultSession;
  if (config.mode === "none") {
    await ses.setProxy({ mode: "direct" });
  } else if (config.mode === "custom") {
    const proxyRules = toProxyRules(config.url);
    if (proxyRules) {
      await ses.setProxy({ mode: "fixed_servers", proxyRules });
    } else {
      await ses.setProxy({ mode: "system" });
    }
  } else {
    await ses.setProxy({ mode: "system" });
  }
  try {
    await ses.closeAllConnections();
  } catch {
    /* 老版本 Electron 没有该方法：忽略，下一次新连接即生效 */
  }
  log.info(`网络代理已应用：${config.mode}${config.mode === "custom" ? ` ${config.url}` : ""}`);
}
