/**
 * 后端进程进程的生命周期与命令/事件通道。
 *
 * ```
 * 渲染进程 --IPC--> 主进程 --HTTP POST /cmd--> 后端进程
 * 渲染进程 <--IPC-- 主进程 <----SSE /events-- 后端进程
 * ```
 *
 * 端口由侧车自己选（绑 127.0.0.1:0）并打印一行
 * `SILVERMOON_READY {"port":N}`，我们从 stdout 里解析。
 *
 * 关于 stdin：侧车会监听 stdin，读到 EOF 就自行退出。所以这里**始终保持**
 * `child.stdin` 打开，退出时先 end() 再 kill，避免留下孤儿进程。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { randomBytes } from "node:crypto";

import { config, isDev, projectRoot, iconPath } from "./config";
import { log } from "./log";

export interface CommandReply {
  ok: boolean;
  data?: unknown;
  error?: string;
}

/** 侧车 → 渲染进程的事件帧。 */
export interface EventFrame {
  event: string;
  target: string | null;
  payload: unknown;
}

export interface SidecarOptions {
  dataDir: string;
  cacheDir: string;
  /** 宿主（本进程）HTTP 服务的端口，供侧车反向调用 */
  hostPort: number;
  hostToken: string;
}

/**
 * 侧车管理器。
 *
 * 未就绪时 `callCommand` 会以明确的中文错误拒绝——这是开发期的常见状态
 * （本地没有 Rust 工具链、还没产出 target/debug 可执行文件），必须让前端
 * 看到「后端未启动」而不是一个含糊的超时。
 */
export class Sidecar extends EventEmitter {
  private child: ChildProcess | null = null;
  private port = 0;
  private token = "";
  private ready = false;
  private sseAbort: AbortController | null = null;
  private stopping = false;

  /** 就绪状态变化 */
  get isReady(): boolean {
    return this.ready;
  }

  /**
   * 解析侧车可执行文件路径。带 `SILVERMOON_SERVER_BIN` 环境变量可覆盖。
   *
   * 注意：这里必须用 `isDev`（其真源是 `app.isPackaged`），**不要用环境变量判断**——
   * 之前误用了一个从未被设置的 `SILVERMOON_PACKAGED`，导致打包后的应用恒走开发分支，
   * 去 `backend/target/` 找可执行文件而必然失败（界面报「后端未启动」）。
   */
  static resolveBinary(): string | null {
    const override = process.env.SILVERMOON_SERVER_BIN;
    if (override && existsSync(override)) return override;

    const win = process.platform === "win32";
    const exeName = win ? `${config.sidecar.binary}.exe` : config.sidecar.binary;
    const devName = win ? `${config.sidecar.devBinary}.exe` : config.sidecar.devBinary;

    const candidates = isDev
      ? [
          // 开发期：cargo build 的产物（debug 优先，其次 release）
          path.join(projectRoot, "backend", "target", "debug", devName),
          path.join(projectRoot, "backend", "target", "release", devName),
          path.join(projectRoot, "backend", "target", "debug", exeName),
          path.join(projectRoot, "backend", "target", "release", exeName),
        ]
      : [
          // 打包后：electron-builder 的 extraResources 落在 resources/ 下
          path.join(process.resourcesPath, "bin", exeName),
          path.join(process.resourcesPath, exeName),
        ];

    const hit = candidates.find((p) => existsSync(p));
    if (!hit) {
      log.error(
        `未找到侧车可执行文件（isDev=${isDev}）。已尝试以下路径：\n  ${candidates.join("\n  ")}`,
      );
    }
    return hit ?? null;
  }

  /** 启动侧车。返回是否成功拉起。 */
  async start(options: SidecarOptions): Promise<boolean> {
    const binary = Sidecar.resolveBinary();
    if (!binary) {
      log.warn(
        "未找到 后端进程可执行文件，进入「后端不可用」降级模式。" +
          "开发期请先构建：cargo build（产物在 backend/target/debug/）。",
      );
      return false;
    }

    this.token = randomBytes(24).toString("hex");

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      // 数据目录由主进程决定，两侧共用同一份（store / 皮肤 / 扩展 / 登录态）
      SILVERMOON_DATA_DIR: options.dataDir,
      SILVERMOON_CACHE_DIR: options.cacheDir,
      SILVERMOON_TOKEN: this.token,
      // 反向通道：侧车据此回调宿主（窗口、托盘、热键、打开文件）
      SILVERMOON_HOST_PORT: String(options.hostPort),
      SILVERMOON_HOST_TOKEN: options.hostToken,
      RUST_BACKTRACE: isDev ? "1" : "0",
    };
    const icon = iconPath();
    if (icon) env.SILVERMOON_ICON_PATH = icon;

    log.info(`启动侧车：${binary}`);
    const child = spawn(binary, [], {
      cwd: path.dirname(binary),
      env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child = child;

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");

    const readyPromise = new Promise<boolean>((resolve) => {
      let buffer = "";
      let settled = false;

      child.stdout?.on("data", (chunk: string) => {
        buffer += chunk;
        let index: number;
        while ((index = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, index).trim();
          buffer = buffer.slice(index + 1);
          if (!line) continue;

          const match = /^SILVERMOON_READY\s+(\{.*\})$/.exec(line);
          if (match && !settled) {
            try {
              this.port = JSON.parse(match[1]).port as number;
              this.ready = true;
              settled = true;
              log.info(`侧车就绪，命令服务端口 ${this.port}`);
              this.attachEvents();
              resolve(true);
            } catch (error) {
              log.error("解析侧车就绪行失败：", error);
            }
          } else {
            log.info(`[sidecar] ${line}`);
          }
        }
      });
    });

    child.stderr?.on("data", (chunk: string) => log.info(`[sidecar:err] ${chunk.trimEnd()}`));

    child.on("exit", (code, signal) => {
      log.warn(`侧车退出：code=${code} signal=${signal}`);
      this.ready = false;
      this.child = null;
      this.sseAbort?.abort();
      this.sseAbort = null;
      if (!this.stopping) {
        this.emit("crashed", { code, signal });
      }
      this.emit("down");
    });

    child.on("error", (error) => log.error("侧车启动失败：", error));

    // 15s 内没打出就绪行就认为启动失败（首次启动要建库、拉扩展，给足时间）
    const timeout = new Promise<boolean>((resolve) => setTimeout(() => resolve(this.ready), 15000));
    const ok = await Promise.race([readyPromise, timeout]);
    if (!ok) {
      log.error("侧车在超时时间内未就绪；命令调用将返回「后端未启动」");
    }
    return ok;
  }

  /** 优雅停止：先关 stdin 让侧车自己退出，超时再强杀。 */
  async stop(): Promise<void> {
    this.stopping = true;
    this.sseAbort?.abort();
    this.sseAbort = null;
    const child = this.child;
    if (!child) return;
    log.info("停止侧车…");
    try {
      child.stdin?.end();
    } catch {
      /* ignore */
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill();
        resolve();
      }, 3000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    this.child = null;
    this.ready = false;
  }

  /** 调用一个 Rust 命令。 */
  async callCommand(cmd: string, args: unknown): Promise<CommandReply> {
    if (!this.ready) {
      return { ok: false, error: "后端未启动：后端进程不可用，请检查是否已构建 backend" };
    }
    try {
      return await this.post("/cmd", { cmd, args: args ?? {} });
    } catch (error) {
      log.error(`命令 ${cmd} 调用异常：`, error);
      return { ok: false, error: `命令 ${cmd} 调用失败：${(error as Error).message}` };
    }
  }

  /**
   * 反向回调：宿主 → Rust（导航是否放行、托盘点击、热键）。
   *
   * 未就绪时返回 `{ ok: false }`，调用方据此走「默认放行/忽略」，
   * 不会因为后端还没起来就卡住窗口导航。
   */
  async callback(payload: Record<string, unknown>): Promise<CommandReply> {
    if (!this.ready) return { ok: false, error: "侧车未就绪" };
    try {
      return await this.post("/_host", payload);
    } catch (error) {
      log.warn("侧车回调异常：", (error as Error).message);
      return { ok: false, error: (error as Error).message };
    }
  }

  private async post(route: string, body: unknown): Promise<CommandReply> {
    const response = await fetch(`http://127.0.0.1:${this.port}${route}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-SilverMoon-Token": this.token,
      },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    try {
      return JSON.parse(text) as CommandReply;
    } catch {
      return {
        ok: false,
        error: `后端返回了非 JSON 响应（HTTP ${response.status}）：${text.slice(0, 200)}`,
      };
    }
  }

  /**
   * 订阅 SSE 事件流并转发给主进程内部（由 `ipc.ts` 再分发给渲染窗口）。
   *
   * 断线自动重连：侧车重启后无需重启前端。
   */
  private attachEvents(): void {
    const abort = new AbortController();
    this.sseAbort = abort;
    void this.consumeEvents(abort.signal);
  }

  private async consumeEvents(signal: AbortSignal): Promise<void> {
    while (!signal.aborted && this.ready) {
      try {
        const response = await fetch(`http://127.0.0.1:${this.port}/events`, {
          headers: { "X-SilverMoon-Token": this.token },
          signal,
        });
        if (!response.body) throw new Error("SSE 无响应体");

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let index: number;
          while ((index = buffer.indexOf("\n\n")) >= 0) {
            const raw = buffer.slice(0, index);
            buffer = buffer.slice(index + 2);
            const dataLine = raw.split("\n").find((l) => l.startsWith("data:"));
            if (!dataLine) continue;
            try {
              const frame = JSON.parse(dataLine.slice(5).trim()) as EventFrame;
              this.emit("event", frame);
            } catch {
              /* 忽略半截/心跳帧 */
            }
          }
        }
      } catch (error) {
        if (signal.aborted) return;
        log.warn("SSE 连接中断，1s 后重连：", (error as Error).message);
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  }
}
