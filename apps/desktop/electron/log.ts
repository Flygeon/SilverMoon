/**
 * 极简日志：同时写 stderr 与数据目录下的 `logs/main.log`。
 *
 * 之所以要落盘：Electron 打包后 stderr 不可见，而排查启动期问题
 * （后端进程拉起失败、协议注册失败）只能靠日志。
 */
import { appendFileSync, mkdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import path from "node:path";

let logFile: string | null = null;

/**
 * 日志轮转参数。
 *
 * 此前是单个 appendFileSync 且**无任何上限**，而侧车的 stdout / stderr 是逐行写进来的
 * （见 sidecar.ts），长跑必然无限增长。这里按 1MB × 3 归档。
 */
const MAX_LOG_BYTES = 1024 * 1024;
const MAX_LOG_FILES = 3;
/** 每 N 次写入才 statSync 一次，避免每行都做一次系统调用。 */
const ROTATE_CHECK_EVERY = 100;
let writesSinceCheck = 0;

/** 把超过上限的 main.log 滚动为 main.log.1 / .2 / .3（最旧的丢弃）。 */
function rotateIfNeeded(): void {
  if (!logFile) return;
  if (++writesSinceCheck < ROTATE_CHECK_EVERY) return;
  writesSinceCheck = 0;
  try {
    if (statSync(logFile).size < MAX_LOG_BYTES) return;
    try {
      unlinkSync(`${logFile}.${MAX_LOG_FILES}`);
    } catch {
      /* 最旧的那份可能还不存在 */
    }
    for (let i = MAX_LOG_FILES - 1; i >= 1; i--) {
      try {
        renameSync(`${logFile}.${i}`, `${logFile}.${i + 1}`);
      } catch {
        /* 该序号的归档不存在 */
      }
    }
    renameSync(logFile, `${logFile}.1`);
  } catch {
    /* 轮转失败绝不能影响主流程 */
  }
}

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
      rotateIfNeeded();
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
