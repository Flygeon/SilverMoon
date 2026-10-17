/**
 * 番茄内容源 sidecar 的进程管理与调用通道。
 *
 * ```
 * 渲染进程 --IPC--> 主进程 --stdin 行 JSON--> silvermoon-fqapi
 * 渲染进程 <--IPC-- 主进程 <--stdout 行 JSON-- silvermoon-fqapi
 * ```
 *
 * 它与后端 sidecar 的差别：**没有端口、没有 HTTP**。协议是 stdin/stdout
 * 行分隔 JSON，握手行是 `FQAPI_READY {"pid":N,"version":"..."}`。
 *
 * 为什么另起一个进程而不是编进 backend：它依赖 reqwest 0.13 + rustls(ring)，
 * 而 backend 是 reqwest 0.12 + native-tls。同 crate 会有两份 reqwest、
 * 编译时间翻倍，且 TLS provider 只能选一个。独立进程还让上游封禁 / 设备池
 * 异常不波及主应用。
 *
 * 关于 stdin：与 backend 侧车同理，**始终保持打开**；退出时先 end() 再
 * kill，避免留下孤儿进程。sidecar 读到 EOF 会自行退出，在 Windows 上不能
 * 指望 SIGTERM。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";

import { isDev, projectRoot } from "./config";
import { log } from "./log";

/** 一行请求。`op` 用于非路由命令（ping / selftest / chapter）。 */
export interface FqapiRequest {
  op?: string;
  path?: string;
  query?: string;
  method?: string;
  itemId?: string;
}

export interface FqapiOptions {
  /** 数据根目录（设备池、漫画/视频缓存都落在这里）。 */
  dataDir: string;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

const READY_PREFIX = "FQAPI_READY";

/**
 * 可执行文件路径。
 *
 * 发布布局：`resources/bin/silvermoon-fqapi[.exe]`（electron-builder
 * extraResources，与 silvermoon-server 同级）。
 * 开发布局：`fqapi/target/{release,debug}/silvermoon-fqapi[.exe]`。
 *
 * 按「同目录 → 上一级」两级回退，与 splash 的 pathfind 同思路：打包后
 * `process.resourcesPath` 已经是 resources/ 本身，而开发期要从项目根找。
 */
export function fqapiBinaryPath(): string | null {
  const exe = process.platform === "win32" ? "silvermoon-fqapi.exe" : "silvermoon-fqapi";

  // 与 sidecar.ts 的写法保持一致：**按 isDev 分流**，而不是把两条路径混在
  // 一个候选数组里靠 existsSync 撞运气。开发期 process.resourcesPath 指向
  // Electron 自己的 resources 目录，混在一起会让排障时的日志误导人。
  const candidates = isDev
    ? [
        // 开发期：cargo build 的产物（debug 优先，其次 release）
        path.join(projectRoot, "fqapi", "target", "debug", exe),
        path.join(projectRoot, "fqapi", "target", "release", exe),
      ]
    : [
        // 打包后：electron-builder 的 extraResources 落在 resources/bin/
        path.join(process.resourcesPath, "bin", exe),
        path.join(process.resourcesPath, exe),
      ];

  const hit = candidates.find((p) => existsSync(p));
  if (!hit) {
    log.error(
      `未找到番茄内容源可执行文件（isDev=${isDev}）。已尝试：\n  ${candidates.join("\n  ")}`,
    );
  }
  return hit ?? null;
}

/**
 * 番茄内容源管理器。
 *
 * **懒启动**：只有第一次真正调用时才拉起进程。没人用这个源的用户不该为此
 * 付一个常驻进程的代价（它还要维护 5 台设备的池）。
 */
export class FqapiManager extends EventEmitter {
  private child: ChildProcess | null = null;
  private ready = false;
  private starting: Promise<boolean> | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private stdoutBuffer = "";
  private stopping = false;

  constructor(private readonly options: FqapiOptions) {
    super();
  }

  /** 进程是否已就绪。 */
  get isReady(): boolean {
    return this.ready;
  }

  /** 拉起进程并等待握手行。并发调用共享同一次启动。 */
  async ensureStarted(): Promise<boolean> {
    if (this.ready) return true;
    if (this.starting) return this.starting;
    this.starting = this.start().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async start(): Promise<boolean> {
    const binary = fqapiBinaryPath();
    if (!binary) {
      log.warn("未找到 silvermoon-fqapi 可执行文件；番茄内容源不可用");
      return false;
    }

    const dataDir = path.join(this.options.dataDir, "fqapi");
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      SILVERMOON_FQAPI_DATA: dataDir,
      RUST_BACKTRACE: isDev ? "1" : "0",
    };

    log.info(`启动番茄内容源：${binary}`);
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
      let settled = false;
      child.stdout?.on("data", (chunk: string) => {
        this.stdoutBuffer += chunk;
        let index: number;
        while ((index = this.stdoutBuffer.indexOf("\n")) >= 0) {
          const line = this.stdoutBuffer.slice(0, index).trim();
          this.stdoutBuffer = this.stdoutBuffer.slice(index + 1);
          if (!line) continue;

          if (line.startsWith(READY_PREFIX) && !settled) {
            settled = true;
            this.ready = true;
            log.info(`番茄内容源就绪：${line.slice(READY_PREFIX.length).trim()}`);
            resolve(true);
            continue;
          }
          this.handleLine(line);
        }
      });
    });

    child.stderr?.on("data", (chunk: string) => log.info(`[fqapi:err] ${chunk.trimEnd()}`));

    child.on("exit", (code, signal) => {
      log.warn(`番茄内容源退出：code=${code} signal=${signal}`);
      this.ready = false;
      this.child = null;
      this.failAllPending("内容源进程已退出");
      if (!this.stopping) this.emit("crashed", { code, signal });
    });

    child.on("error", (error) => log.error("番茄内容源启动失败：", error));

    // 20s：首次启动要建数据目录，但不需要建库，给足余量。
    const timeout = new Promise<boolean>((resolve) =>
      setTimeout(() => resolve(this.ready), 20000).unref?.(),
    );
    const ok = await Promise.race([readyPromise, timeout]);
    if (!ok) log.error("番茄内容源在超时时间内未就绪");
    return ok;
  }

  private handleLine(line: string): void {
    let frame: { id?: number; error?: string; [key: string]: unknown };
    try {
      frame = JSON.parse(line) as typeof frame;
    } catch {
      log.warn(`[fqapi] 无法解析的行：${line.slice(0, 200)}`);
      return;
    }
    const id = frame.id;
    if (typeof id !== "number") {
      log.info(`[fqapi] ${line.slice(0, 200)}`);
      return;
    }
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    pending.resolve(frame);
  }

  private failAllPending(reason: string): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
      this.pending.delete(id);
    }
  }

  /**
   * 发一条请求并等响应。
   *
   * 未就绪时**先尝试拉起**，拉不起来才报错——这样调用方（渲染进程）不必
   * 关心 sidecar 生命周期。
   */
  async request(req: FqapiRequest, timeoutMs = 60000): Promise<unknown> {
    const ok = await this.ensureStarted();
    if (!ok || !this.child?.stdin?.writable) {
      throw new Error("番茄内容源未就绪（可执行文件缺失或启动失败）");
    }

    const id = this.nextId++;
    const line = `${JSON.stringify({ id, ...req })}\n`;
    const response = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`番茄内容源请求超时（${timeoutMs}ms）`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
    });

    this.child.stdin.write(line);
    return response;
  }

  /** 优雅停掉：先关 stdin（sidecar 读到 EOF 自行退出），再兜底 kill。 */
  async stop(): Promise<void> {
    this.stopping = true;
    const child = this.child;
    if (!child) return;
    try {
      child.stdin?.end();
    } catch {
      /* ignore */
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          /* ignore */
        }
        resolve();
      }, 3000);
      timer.unref?.();
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    this.child = null;
    this.ready = false;
  }
}

/** 进程级单例（主进程内只该有一个 sidecar）。 */
let manager: FqapiManager | null = null;

/**
 * 取单例。`dataDir` 由主进程传入（它是 `<appData>/<identifier>`，
 * 与 Rust 侧 `app_data_dir()` 同一个目录），这里不自己去推路径。
 */
export function getFqapiManager(dataDir: string): FqapiManager {
  if (manager) return manager;
  manager = new FqapiManager({ dataDir });
  return manager;
}

/** 仅供测试：重置单例。 */
export function resetFqapiManagerForTest(): void {
  manager = null;
}
