/**
 * 桌面歌词窗口：拉起 Rust 原生进程并与之通信。
 *
 * ## 为什么不再是 BrowserWindow
 *
 * 2026-10-15 实测：Electron 的 \`BrowserWindow\` 被 \`SetParent\` 进任务栏后
 * ①位置/尺寸被 Chromium 抢回（900ms 内弹回原处）②渲染变纯黑 ——
 * 因为它的 HWND **本身就是 Chromium 的顶层 widget**，没有中间层可拦。
 *
 * 现在改为**独立的 Rust 原生进程**（apps/desktop/lyrics）：
 * 它自己建窗口、自己 SetParent 进任务栏、再 \`wry::build_as_child\` 把
 * WebView2 作为**子控件**挂进去。外层窗口归它的消息循环管，
 * 不存在被抢的问题。这与参考项目 TaskbarLyrics 的 WPF 结构同构
 * （外层 Window + 内层 WebView2）。
 *
 * ## 通信
 *
 * 行分隔 JSON 走 stdin/stdout（见 lyrics/src/ipc.rs 的协议说明）：
 * - 我们 → 它：歌词状态 / 频谱 / 设置 / 退出
 * - 它 → 我们：\`LYRICS_READY {json}\` 握手、播放控制、错误
 *
 * **stdin EOF = 它退出**，所以我们关窗口时只需 end() stdin，
 * 不必（也不该）用 kill —— 那会留下没清理的 WebView2 进程。
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { config, isDev } from "./config";
import { log } from "./log";

/** 握手行前缀（与 Rust 侧 ipc.rs 的 READY_PREFIX 一致）。 */
const READY_PREFIX = "LYRICS_READY";

/** 歌词进程的可执行文件名。 */
const BIN_NAME = process.platform === "win32" ? "silvermoon-lyrics.exe" : "silvermoon-lyrics";

export interface LyricsReady {
  hwnd: number;
  /** 是否成功真嵌入任务栏。false 时调用方应提示用户或回退浮贴 */
  embedded: boolean;
}

export interface LyricsStatePayload {
  lines: Array<{
    time: number;
    text: string;
    translation?: string;
    bg?: string;
    units?: Array<{ start: number; end: number }>;
  }>;
  currentTime: number;
  playing: boolean;
  title: string;
  artist: string;
}

export interface LyricsSettingsPayload {
  fontSize?: number;
  opacity?: number;
  showTranslation?: boolean;
  showNext?: boolean;
  wordByWord?: boolean;
  align?: string;
  offsetX?: number;
  offsetY?: number;
}

export type LyricsControlAction = "toggle" | "next" | "prev" | "close";

/**
 * 定位歌词进程可执行文件。
 *
 * 与 sidecar 同一套布局约定：打包后在 \`resources/bin/\`，开发态在
 * \`lyrics/target/{debug,release}/\`。找不到时返回 null（调用方据此降级，
 * 而不是抛错让整个应用起不来）。
 */
function locateBinary(): string | null {
  const candidates: string[] = [];
  if (isDev) {
    const root = path.resolve(__dirname, "..");
    candidates.push(path.join(root, "lyrics", "target", "release", BIN_NAME));
    candidates.push(path.join(root, "lyrics", "target", "debug", BIN_NAME));
  }
  candidates.push(path.join(process.resourcesPath, "bin", BIN_NAME));

  // 允许用环境变量直接指定（便于本地调试与 CI 冒烟）
  const override = process.env.SILVERMOON_LYRICS_BIN;
  if (override) candidates.unshift(override);

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      /* 探测失败就试下一个 */
    }
  }
  return null;
}

/**
 * 歌词进程管理器。
 *
 * 生命周期由主进程控制：\`start()\` 拉起并等握手，\`stop()\` 关 stdin 让它自己退。
 */
export class LyricsWindow {
  private child: ChildProcess | null = null;
  private ready = false;
  private readyInfo: LyricsReady | null = null;
  private readonly readyWaiters: Array<(info: LyricsReady | null) => void> = [];
  private onControl: ((action: LyricsControlAction) => void) | null = null;
  private stopping = false;

  /** 是否已就绪（握手完成）。 */
  get isReady(): boolean {
    return this.ready;
  }

  /** 最近一次握手信息（含 embedded 标志）。 */
  get info(): LyricsReady | null {
    return this.readyInfo;
  }

  /** 注册播放控制回调（上一首/播放/下一首/关闭）。 */
  setControlHandler(handler: (action: LyricsControlAction) => void): void {
    this.onControl = handler;
  }

  /**
   * 拉起歌词进程并等握手。
   *
   * @returns 握手信息；进程起不来或超时时返回 null（调用方据此提示用户）
   */
  async start(): Promise<LyricsReady | null> {
    if (this.child) return this.readyInfo;

    const binary = locateBinary();
    if (!binary) {
      log.warn("找不到歌词进程可执行文件，桌面歌词不可用");
      return null;
    }

    this.stopping = false;
    log.info(`启动歌词进程：${binary}`);

    const child = spawn(binary, [], {
      cwd: path.dirname(binary),
      // 只保留 stdin/stdout/stderr：它是纯渲染进程，不需要我们的环境变量
      env: { ...process.env, RUST_BACKTRACE: isDev ? "1" : "0" },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child = child;

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");

    let buffer = "";
    child.stdout?.on("data", (chunk: string) => {
      buffer += chunk;
      let index: number;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (line) this.handleLine(line);
      }
    });

    child.stderr?.on("data", (chunk: string) => log.info(`[lyrics:err] ${chunk.trimEnd()}`));

    child.on("exit", (code, signal) => {
      log.warn(`歌词进程退出：code=${code} signal=${signal}`);
      this.child = null;
      this.ready = false;
      this.readyInfo = null;
      // 未主动停止时唤醒所有等待者，让它们拿到 null 而不是一直挂着
      if (!this.stopping) this.settleWaiters(null);
    });

    return await this.waitReady(8000);
  }

  /** 处理一行来自歌词进程的输出。 */
  private handleLine(line: string): void {
    if (line.startsWith(READY_PREFIX)) {
      const json = line.slice(READY_PREFIX.length).trim();
      try {
        const info = JSON.parse(json) as LyricsReady;
        this.ready = true;
        this.readyInfo = info;
        log.info(`歌词窗口就绪：hwnd=${info.hwnd} 嵌入=${info.embedded}`);
        if (!info.embedded) {
          // 如实记录：嵌入失败时窗口可能飘在屏幕外，这是排查的第一线索
          log.warn("歌词窗口**未能嵌入任务栏**（窗口可能不在预期位置）");
        }
        this.settleWaiters(info);
      } catch (error) {
        log.error("解析歌词进程握手行失败：", error);
      }
      return;
    }

    try {
      const msg = JSON.parse(line) as { type?: string; action?: string; message?: string };
      if (msg.type === "control" && msg.action) {
        this.onControl?.(msg.action as LyricsControlAction);
      } else if (msg.type === "error") {
        log.warn(`[lyrics] ${msg.message ?? "未知错误"}`);
      }
    } catch {
      // 非 JSON 行（例如调试输出）：原样记日志，不影响功能
      log.info(`[lyrics] ${line}`);
    }
  }

  /** 等握手；超时或进程退出都返回 null。 */
  private waitReady(timeoutMs: number): Promise<LyricsReady | null> {
    if (this.ready && this.readyInfo) return Promise.resolve(this.readyInfo);
    return new Promise((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        log.warn("歌词进程握手超时");
        resolve(null);
      }, timeoutMs);

      this.readyWaiters.push((info) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(info);
      });
    });
  }

  private settleWaiters(info: LyricsReady | null): void {
    const waiters = this.readyWaiters.splice(0, this.readyWaiters.length);
    for (const w of waiters) w(info);
  }

  /** 推一条 JSON 给歌词进程。未就绪时静默丢弃（窗口还没准备好收）。 */
  private send(payload: unknown): void {
    const child = this.child;
    if (!child?.stdin || child.stdin.destroyed) return;
    try {
      child.stdin.write(JSON.stringify(payload) + "\n");
    } catch (error) {
      log.warn("写歌词进程失败：", error);
    }
  }

  /** 推歌词状态。 */
  pushState(state: LyricsStatePayload): void {
    this.send({ type: "state", payload: state });
  }

  /** 推频谱。 */
  pushSpectrum(bins: number[]): void {
    this.send({ type: "spectrum", payload: { bins } });
  }

  /** 推设置。 */
  pushSettings(settings: LyricsSettingsPayload): void {
    this.send({ type: "settings", payload: settings });
  }

  /**
   * 关闭歌词进程。
   *
   * **关 stdin 而不是 kill**：Rust 侧读到 EOF 会自己销毁窗口并退出，
   * WebView2 的资源也能正常释放。kill 会留下没清理的渲染子进程。
   */
  async stop(): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.stopping = true;
    try {
      child.stdin?.end();
    } catch {
      /* 已经关了 */
    }
    // 给它一点时间自己退；超时再强杀，避免真的留下孤儿
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          /* 已经没了 */
        }
        resolve();
      }, 1500);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    this.child = null;
    this.ready = false;
    this.readyInfo = null;
  }
}

/** 进程级单例（一个应用只开一个歌词窗口）。 */
export const lyricsWindow = new LyricsWindow();
