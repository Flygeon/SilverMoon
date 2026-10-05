/**
 * 启动诊断收集：把两个原生进程的启动轨迹汇总成一段可复制的文本。
 *
 * ## 为什么需要它
 *
 * Win7 上实际发生的两类崩溃（启动器 `c0000005`、后端 `0xC0000005`）都是
 * **GUI 进程静默消失**：没有控制台、没有堆栈，用户只能看到一句
 * 「后端进程已退出」。要求用户自己去 `%TEMP%` 里翻两个文件、再判断该看哪一个，
 * 是把诊断成本转嫁给了最不了解内部结构的人。
 *
 * 而且 `%TEMP%` 在 Windows 7 上**是隐藏目录**，资源管理器默认不显示。
 *
 * 所以这里把三个来源合并成一段文本（后端轨迹 + 启动器轨迹 + 主进程日志尾部），
 * 由 Electron 在崩溃时直接呈现，并同时落盘一份到数据目录的 logs/。
 *
 * ## 为什么不直接读 lumiluna_login_debug.log
 *
 * 那个文件是**业务**日志（登录、panic 回溯），可能积累很多历史内容且没有
 * 本次启动的边界。排查「一启动就死」时，它的信噪比远不如按启动覆盖写的轨迹文件。
 * 两者都收集，但把轨迹排在前面。
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { log } from "./log";

/** 轨迹文件名前缀（与 Rust 侧 `boot_trace::init` 的命名保持一致）。 */
const TRACE_PREFIX = "silvermoon-boot-";

/** 单个文件最多读多少字符（防止异常情况下日志爆炸撑爆弹窗）。 */
const MAX_CHARS = 6000;

/** 读取一个文件的内容；不存在或失败返回 null。 */
function readOrNull(file: string): string | null {
  try {
    if (!existsSync(file)) return null;
    const text = readFileSync(file, "utf8");
    if (text.length <= MAX_CHARS) return text;
    // 超长时保留**尾部**：排查崩溃只关心最后几行。
    return `…（已截断前 ${text.length - MAX_CHARS} 字符）…\n` + text.slice(-MAX_CHARS);
  } catch (e) {
    return `（读取失败：${String(e)}）`;
  }
}

/** 收集一次完整诊断快照。 */
export interface BootDiagnostics {
  /** 可直接展示 / 复制的整段文本 */
  text: string;
  /** 已经找到的轨迹文件数量（0 = 两个原生进程都没跑到 main） */
  found: number;
  /** 后端轨迹是否出现「正常退出」标记 */
  backendExitedNormally: boolean;
  /** 后端轨迹的最后一行 STEP（崩溃区间下界） */
  backendLastStep: string | null;
  /** 启动器轨迹的最后一行 STEP */
  splashLastStep: string | null;
}

/** 取某份轨迹里最后一个 STEP 行 —— 那就是「最后成功进入的阶段」。 */
function lastStep(text: string | null): string | null {
  if (!text) return null;
  const lines = text.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    // 跳过截断提示行
    if (line.includes("已截断")) continue;
    if (line.includes("STEP")) return line.trim();
  }
  return null;
}

/**
 * 汇总启动诊断。
 *
 * @param extraLogTail 额外附上的文本（通常是 main.log 的尾部）
 */
export function collectBootDiagnostics(extraLogTail?: string): BootDiagnostics {
  const tmp = os.tmpdir();
  const files: { label: string; file: string }[] = [
    { label: "后端（silvermoon-server.exe）", file: path.join(tmp, `${TRACE_PREFIX}backend.log`) },
    { label: "启动器（silvermoon-splash.exe）", file: path.join(tmp, `${TRACE_PREFIX}splash.log`) },
    {
      label: "业务/panic 日志（lumiluna_login_debug.log）",
      file: path.join(tmp, "lumiluna_login_debug.log"),
    },
  ];

  const sections: string[] = [];
  let found = 0;
  let backendText: string | null = null;
  let splashText: string | null = null;

  for (const { label, file } of files) {
    const text = readOrNull(file);
    if (text === null) {
      sections.push(`### ${label}\n（不存在：${file}）`);
      continue;
    }
    found++;
    if (label.startsWith("后端")) backendText = text;
    if (label.startsWith("启动器")) splashText = text;
    sections.push(`### ${label}\n路径：${file}\n\n${text.trimEnd()}`);
  }

  if (extraLogTail) {
    sections.push(`### 主进程日志尾部（main.log）\n\n${extraLogTail.trimEnd()}`);
  }

  const header = [
    "SilverMoon 启动诊断",
    `生成时间：${new Date().toISOString()}`,
    `平台：${process.platform} ${os.release()}`,
    `Electron：${process.versions.electron ?? "?"} / Node：${process.versions.node ?? "?"} / Chromium：${
      process.versions.chrome ?? "?"
    }`,
    "",
    "每份轨迹里**最后一行的 STEP** 就是「最后成功进入的阶段」——",
    "进程若在下一步崩溃，那一行之后的内容都不会出现，据此可定位崩溃区间。",
    "",
  ].join("\n");

  const text = header + sections.join("\n\n");

  return {
    text,
    found,
    backendExitedNormally: Boolean(backendText && backendText.includes("run() 正常返回")),
    backendLastStep: lastStep(backendText),
    splashLastStep: lastStep(splashText),
  };
}

/**
 * 把诊断写进数据目录的 logs/，返回落盘路径（失败返回 null）。
 *
 * 落盘的理由：崩溃弹窗可能被用户直接关掉、也可能因为二次崩溃弹不出来。
 * 文件是最后一道保险。
 */
export function persistBootDiagnostics(dir: string, text: string): string | null {
  try {
    const file = path.join(dir, "boot-diagnostics.txt");
    writeFileSync(file, text, "utf8");
    log.info(`启动诊断已落盘：${file}`);
    return file;
  } catch (e) {
    log.warn("启动诊断落盘失败：", e);
    return null;
  }
}
