/**
 * AutoMix 调试通道。
 *
 * 需求是「在前端控制台添加相关调试选项，记录生效流程」——所以这里把整个
 * 过渡流程的每一步都留痕，并暴露一个控制台 API，便于排查
 * 「为什么这次没对拍」「为什么过渡点在这里」。
 *
 * ## 用法（DevTools 控制台）
 *
 *   __automix.enable()        开启详细日志
 *   __automix.disable()       关闭
 *   __automix.status()        当前运行时状态
 *   __automix.trace()         最近 100 条流程记录
 *   __automix.last()          最近一次过渡的完整决策依据
 *   __automix.clearCache()    清空分析缓存
 *   __automix.forceMix()      强制下一次曲末执行一次过渡
 */

export type AutoMixLogLevel = "info" | "warn" | "error";

export interface AutoMixLogEntry {
  t: number;
  level: AutoMixLogLevel;
  msg: string;
  detail?: unknown;
}

/** 环形缓冲上限：调试用，不需要无限增长 */
const MAX_ENTRIES = 100;
const entries: AutoMixLogEntry[] = [];

let verbose = false;
/** 是否强制下一次过渡（__automix.forceMix() 用） */
let forceNext = false;

const PREFIX = "[AutoMix]";

function push(level: AutoMixLogLevel, msg: string, detail?: unknown): void {
  entries.push({ t: Date.now(), level, msg, detail });
  if (entries.length > MAX_ENTRIES) entries.shift();
  if (!verbose) return;
  const fn = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
  if (detail === undefined) fn(PREFIX + " " + msg);
  else fn(PREFIX + " " + msg, detail);
}

/** 记录一条流程日志。 */
export function mixLog(msg: string, detail?: unknown): void {
  push("info", msg, detail);
}

export function mixWarn(msg: string, detail?: unknown): void {
  push("warn", msg, detail);
}

export function mixError(msg: string, detail?: unknown): void {
  push("error", msg, detail);
}

export function isVerbose(): boolean {
  return verbose;
}

export function setVerbose(on: boolean): void {
  verbose = on;
  push("info", on ? "详细日志已开启" : "详细日志已关闭");
  if (on) {
    console.log(PREFIX + " 调试已开启。可用 __automix.status() / .trace() / .last()");
  }
}

export function getEntries(): AutoMixLogEntry[] {
  return [...entries];
}

export function clearEntries(): void {
  entries.length = 0;
}

/** 请求在下一次曲末强制过渡一次。 */
export function requestForceMix(): void {
  forceNext = true;
  push("info", "已请求强制过渡（下一次曲末生效）");
}

/** 读取并清空强制过渡标记。 */
export function consumeForceMix(): boolean {
  const v = forceNext;
  forceNext = false;
  return v;
}
