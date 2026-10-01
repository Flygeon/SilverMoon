/**
 * B 站登录链路诊断日志（前缀 `[bili-login]`，落 `<系统临时目录>/lumiluna_login_debug.log`）。
 *
 * 扫码登录是一条「外部接口 × 凭据形态 × 多步校验」的链路：申请二维码 → 轮询 →
 * 拿凭据（可能是响应的 Set-Cookie，也可能是跳转链 query）→ 转成 cookie 形态 →
 * nav 校验。任何一环出问题，界面上只会看到一句「账号信息获取失败」，从 UI 完全
 * 无从追查（项目硬性约定：新功能必须先埋可持久化日志，见 `danmakuLog.ts`）。
 *
 * 这里同时做三件事：
 * 1. **落文件**：与 `[anime-online]` / `[danmaku]` 共用同一个调试日志文件；
 * 2. **内存环形缓冲**：供界面上「复制日志」一键带走整条链路，不用去临时目录翻文件；
 * 3. **凭据脱敏**：只记长度 / 形态特征 / md5 指纹，**绝不落凭据原值**。
 *
 * 为什么是「指纹」而不是原值：SESSDATA 是可直接登录的凭据，落盘或复制都不该出现
 * 全值；而本次真正要判断的只是**形态**（`%2C` 还是字面逗号）、长度、以及各步骤
 * 拿到的是不是同一个值 —— 这三点指纹全能回答（md5 前 8 位对高熵串不可逆）。
 */
import { capabilities } from "@/capabilities";
import { md5 } from "@/utils/md5";

/** 与 Rust `login_debug_log` 写入的同一个文件（系统临时目录） */
export const BILI_LOG_FILE = "lumiluna_login_debug.log";

/** 内存里保留的最大行数（只用于「复制日志」，落盘是完整的） */
const BUFFER_MAX = 600;

const buffer: string[] = [];

/** 一行日志进缓冲（超过上限丢最旧的） */
function push(line: string): void {
  buffer.push(line);
  if (buffer.length > BUFFER_MAX) buffer.splice(0, buffer.length - BUFFER_MAX);
}

/** 写一条链路日志：落文件 + 进缓冲 + 开发期看 console。 */
export function biliLog(msg: string): void {
  const line = `${new Date().toISOString()} [bili-login] ${msg}`;
  push(line);
  try {
    // 与 animeLog / danmakuLog 同款：日志写失败绝不能影响主流程
    const p = capabilities.appLog(`[bili-login] ${msg}`);
    if (p && typeof (p as Promise<void>).catch === "function") {
      void (p as Promise<void>).catch(() => {});
    }
  } catch {
    /* 忽略：日志不可用不影响功能 */
  }
}

/** 分段标题（会话开始 / 链路结束等），仅影响可读性。 */
export function biliLogSection(title: string): void {
  biliLog(`──────── ${title} ────────`);
}

/**
 * 凭据指纹：长度 + 形态特征 + md5 前 8 位。**不含任何可用于登录的字符**。
 *
 * - `%2C` / `,` 两位正是这次要判的形态（cookie 值不允许逗号，浏览器存的是 `%2C`）；
 * - `*=NN` 是 B 站 SESSDATA 的尾部标记，形态异常时一眼能看出来；
 * - md5 前 8 位用于判断「各步拿到的是不是同一个值」，高熵串不可逆。
 */
export function cookieFingerprint(value: string): string {
  const v = String(value ?? "");
  const star = /\*(\d+)\s*$/.exec(v);
  const bits = [`len=${v.length}`];
  bits.push(`%2C=${v.includes("%2C") ? 1 : 0}`);
  bits.push(`逗号=${v.includes(",") ? 1 : 0}`);
  if (v.includes("%25")) bits.push("%25=1");
  if (star) bits.push(`*=*${star[1]}`);
  bits.push(`md5=${v ? md5(v).slice(0, 8) : "-"}`);
  return `(${bits.join(" ")})`;
}

/** 一批凭据的指纹串，形如 `SESSDATA(len=52 %2C=1 逗号=0 *=*51 md5=1a2b3c4d) bili_jct(len=32 …)`。 */
export function cookieDigest(pairs: Record<string, string> | [string, string][]): string {
  const list = Array.isArray(pairs) ? pairs : Object.entries(pairs);
  if (!list.length) return "（空）";
  return list.map(([name, value]) => `${name}${cookieFingerprint(value)}`).join(" ");
}

/** 只记名字（名字不敏感，且是判断「拿没拿到」的第一手信息）。 */
export function cookieNames(pairs: Record<string, string> | [string, string][]): string {
  const list = Array.isArray(pairs) ? pairs : Object.entries(pairs);
  return list.length ? list.map(([name]) => name).join(",") : "（无）";
}

/** 供界面「复制日志」取用：当前缓冲的完整文本。 */
export function biliLoginLogText(): string {
  return buffer.join("\n");
}

/** 开一次新的登录会话前清空缓冲：复制出去的日志就是干干净净的一条链路。 */
export function biliLoginLogReset(): void {
  buffer.length = 0;
}
