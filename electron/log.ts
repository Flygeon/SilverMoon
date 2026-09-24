/**
 * 极简日志：同时写 stderr 与数据目录下的 `logs/main.log`。
 *
 * 之所以要落盘：Electron 打包后 stderr 不可见，而排查启动期问题
 * （Rust 侧车拉起失败、协议注册失败）只能靠日志。
 */
import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";

let logFile: string | null = null;

/** 指定日志文件位置（在 `app.whenReady` 之前调用即可）。 */
export function initLog(dir: string): void {
  try {
    mkdirSync(dir, { recursive: true });
    logFile = path.join(dir, "main.log");
  } catch {
    logFile = null;
  }
}

function write(level: string, args: unknown[]): void {
  const line = `[${new Date().toISOString()}] [${level}] ${args
    .map((a) => (typeof a === "string" ? a : safeStringify(a)))
    .join(" ")}`;
  if (level === "ERROR") {
    console.error(line);
  } else {
    console.log(line);
  }
  if (logFile) {
    try {
      appendFileSync(logFile, line + "\n", "utf8");
    } catch {
      /* 日志写不进去也不能影响主流程 */
    }
  }
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export const log = {
  info: (...args: unknown[]) => write("INFO", args),
  warn: (...args: unknown[]) => write("WARN", args),
  error: (...args: unknown[]) => write("ERROR", args),
};
