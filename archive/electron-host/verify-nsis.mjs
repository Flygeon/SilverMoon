#!/usr/bin/env node
/**
 * NSIS 脚本语法自检。
 *
 * 为什么需要它：`build/installer.nsh` 只在 **Windows** 的 electron-builder 打包时
 * 才被编译。等到 CI 跑到第 10 分钟才发现「少个 ${EndIf}」，一轮就是 ~12 分钟。
 * 而 makensis 本身跨平台，Linux 上就能把语法与宏展开走完。
 *
 * 做法：搭一个最小 .nsi，复刻 electron-builder 模板里我们会用到的定义与变量，
 * 再把真实的 installer.nsh include 进来、展开 customInstall。
 *
 * 两个已知的环境差异（都在下面显式处理，不是掩盖问题）：
 * 1. `WinShell` 插件由 electron-builder 自带的 NSIS 发行版提供，系统 makensis 没有
 *    → 自检时把它替换成一个等价的 DetailPrint 占位（只验证语法，不验证该插件调用）；
 * 2. `${isNoDesktopShortcut}` 等符号被 electron-builder 模板引用但全仓无定义
 *    → 我们的脚本刻意不引用它们，自检也因此不必伪造。
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(here, "..");
const nshPath = path.join(appRoot, "build", "installer.nsh");

function fail(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

let makensis;
try {
  makensis = execFileSync("makensis", ["-VERSION"], { encoding: "utf8" }).trim();
} catch {
  // 没装 makensis 就跳过（CI 的 Linux job 会装），但不能静默通过
  console.log("⚠ 未检测到 makensis，跳过 NSIS 语法自检（CI 会装并执行）");
  process.exit(0);
}

const source = readFileSync(nshPath, "utf8");

// 去掉注释再断言 —— 文件里刻意用注释解释了「为什么不引用这些符号」，
// 若直接全文 includes 会自己撞上自己的说明文字。
const code = source
  .split("\n")
  .map((line) => line.replace(/;.*$/, ""))
  .join("\n");

// 不得引用全仓无定义的符号（踩过：跟着 electron-builder 模板用会直接编译失败）
for (const sym of ["isNoDesktopShortcut", "isNoStartMenuShortcut"]) {
  if (code.includes(`${sym}`)) {
    fail(`installer.nsh 引用了未定义符号 ${sym} —— electron-builder 只在模板里用，整个包没有定义`);
  }
}

// 必须存在 customInstall 宏（electron-builder 靠 !ifmacrodef 调用它）
if (!/!macro\s+customInstall\b/.test(source)) {
  fail("installer.nsh 缺少 !macro customInstall —— electron-builder 不会调用任何东西");
}

// 必须把快捷方式指向启动器（否则 splash 永远不执行）
if (!source.includes("silvermoon-splash.exe")) {
  fail("installer.nsh 未引用 silvermoon-splash.exe —— 快捷方式不会经过启动器");
}

const dir = mkdtempSync(path.join(tmpdir(), "sm-nsis-"));
const stubbedNsh = path.join(dir, "installer.nsh");
const scriptPath = path.join(dir, "check.nsi");
const outPath = path.join(dir, "check.exe");

// WinShell 是 electron-builder 自带的插件；系统 makensis 没有，替换为占位
writeFileSync(
  stubbedNsh,
  source.replace(/^\s*WinShell::SetLnkAUMI .*$/gm, '    DetailPrint "stub:SetLnkAUMI"'),
);

writeFileSync(
  scriptPath,
  [
    '!include "MUI2.nsh"',
    '!include "LogicLib.nsh"',
    'Name "SilverMoon"',
    `OutFile "${outPath}"`,
    'InstallDir "$TEMP\\SMNsisCheck"',
    "RequestExecutionLevel user",
    '!define APP_DESCRIPTION "SilverMoon"',
    '!define APP_ID "cn.cool.silvermoon"',
    "Var newDesktopLink",
    "Var newStartMenuLink",
    "Var appExe",
    "Var launchLink",
    'Section "Install"',
    '  StrCpy $newDesktopLink "$DESKTOP\\SilverMoon.lnk"',
    '  StrCpy $newStartMenuLink "$SMPROGRAMS\\SilverMoon.lnk"',
    '  StrCpy $appExe "$INSTDIR\\SilverMoon.exe"',
    '  StrCpy $launchLink "$appExe"',
    `!include "${stubbedNsh}"`,
    "  !insertmacro customInstall",
    "SectionEnd",
    "",
  ].join("\n"),
);

let output = "";
try {
  output = execFileSync("makensis", ["-V2", scriptPath], { encoding: "utf8", stdio: "pipe" });
} catch (e) {
  const detail = [e.stdout, e.stderr].filter(Boolean).join("\n");
  fail(`NSIS 编译失败（makensis ${makensis}）：\n${detail}`);
}

// makensis 对错误有时仍返回 0 且把错误写进 stdout，所以要显式查 "Error in"
if (/Error in /i.test(output)) {
  fail(`NSIS 报告错误：\n${output}`);
}

console.log(`✓ NSIS 脚本语法自检通过（makensis ${makensis}）`);
